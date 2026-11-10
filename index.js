/**
 * dsh-plugin-leinao（类脑）—— 从名字开始，慢慢长成自己。
 *
 * 一句话：**事件是唯一真源，性格是慢变量，心情是快变量，语气是它们的投影。**
 *
 *   对话 ──appraise──▶ affect 事件 ──replay──▶ state ──prompt──▶ 这一轮怎么说话
 *                          │                    │
 *                          │                    └── view/PROFILE.md（人看）
 *                          └── journal/<device>/YYYY-MM.jsonl（git 同步）
 *
 * 设计红线（改代码前先读一遍）：
 * 1. 不写 state 到真源：所有写操作都是 append 事件，state.json 只是缓存。
 * 2. 不交互 git：失败只记日志 + 退避，绝不阻塞一轮对话。
 * 3. 心情不碰性格：appraise 只产出 affect；成长必须有 evidence，且限速。
 * 4. 语气不碰事实：prompt 里明确"不确定就说不确定"优先于任何心情档位。
 */
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'

import { DEFAULT_CONFIG, loadConfig } from './src/config.js'
import { ensureDeviceId } from './src/device.js'
import { appendEvent, makeEvent } from './src/journal.js'
import { applyEvent } from './src/replay.js'
import { ensureDirs, journalFingerprint, loadState, personaPaths, saveState, writeFileAtomic } from './src/store.js'
import { renderProfile, writeProfile, writeUserModel } from './src/render.js'
import { buildInjection, buildUserInjection } from './src/prompt.js'
import { observationLines, observationStats } from './src/observations.js'
import { buildUserModel } from './src/userModel.js'
import { userCall } from './src/call.js'
import { appraise } from './src/appraisal.js'
import { registerPersonaTools } from './src/tools.js'
import { detectMend } from './src/bond.js'
import { foldCandidates, memoryIndex, memoryStats } from './src/memory.js'
import { buildGraph } from './src/graph.js'
import { buildHealth } from './src/health.js'
import { ActivityTracker, ProactiveNudge } from './src/proactive.js'
import { SessionGate } from './src/sessions.js'
import { installGraphApi, installSessionApi, installSettingsApi, installUserModelApi } from './src/settings.js'
import { SHIFT } from './src/traits.js'
import { commitAll, createBackoff, ensureRepo, hasRemote, sync } from './src/git.js'

export const name = 'persona'
export const inject = ['tools', 'systemPrompt', 'agents']

/**
 * 测试接缝：DSH 宿主里 defineTool 由 @deepseek-ai/dsh-tools 提供，
 * 但单测里没有这个包。允许测试注入一个等价实现，生产路径不受影响。
 */
let defineToolOverride = null
export function __setDefineTool(fn) {
  defineToolOverride = fn
}

/** cordis 的 ctx.logger 是函数（`ctx.logger('name')` 返回 logger），测试里也可能直接给对象。两种都接。 */
function pickLogger(ctx) {
  let candidate = ctx?.logger ?? console
  if (typeof candidate === 'function') {
    try {
      candidate = candidate('persona') ?? console
    } catch {
      candidate = console
    }
  }
  const emit = (level) => (message) => {
    const fn = candidate?.[level]
    if (typeof fn === 'function') return fn.call(candidate, message)
    return console[level === 'debug' || level === 'info' ? 'log' : level]?.(message)
  }
  return { info: emit('info'), warn: emit('warn'), debug: emit('debug') }
}

/**
 * 证据核验：突变/关系变化的 evidence 必须是用户最近真的说过的话。
 * 只认本进程见过的消息（最多 60 条）——重启后缓冲区是空的，那就诚实拒绝，
 * 而不是"看起来像就放行"。
 */
function createEvidenceCheck() {
  const texts = []
  const norm = (value) => String(value ?? '').replace(/\s+/g, '').trim()
  return {
    remember(text) {
      const clean = String(text ?? '').trim()
      if (!clean) return
      texts.push(norm(clean.slice(0, 4000)))
      while (texts.length > SHIFT.evidenceWindow) texts.shift()
    },
    verify(quote) {
      const q = norm(quote)
      if (!q) return false
      return texts.some((text) => text.includes(q))
    },
    size() {
      return texts.length
    },
  }
}

/** content blocks → 纯文本 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function apply(ctx, inlineConfig = {}) {
  const cfg = loadConfig(inlineConfig)
  const log = pickLogger(ctx)
  if (cfg.enabled === false) {
    log.info?.('[leinao] enabled=false，跳过')
    return
  }

  const dataDir = cfg.dataDir
  ensureDirs(dataDir)
  const paths = personaPaths(dataDir)
  if (!existsSync(join(dataDir, 'journal', '.gitkeep'))) {
    writeFileSync(join(dataDir, 'journal', '.gitkeep'), '', 'utf8')
  }

  let deviceId
  try {
    deviceId = ensureDeviceId(join(cfg.dshHome, 'leinao'), { override: cfg.deviceId })
  } catch (error) {
    log.warn?.(`[leinao] deviceId 不可用，改用临时 id：${error.message}`)
    deviceId = `tmp-${process.pid.toString(16)}`
  }

  if (cfg.journal.git) {
    const repo = ensureRepo(dataDir, { remote: cfg.journal.remote || undefined })
    if (!repo.ok) log.warn?.(`[leinao] git 初始化失败（不影响记录）：${repo.error}`)
  }

  let current = loadState(dataDir)
  /** journal 指纹：没变就不再扫；自己写事件时同步刷新 */
  let currentFp = journalFingerprint(dataDir)
  const evidence = createEvidenceCheck()
  const backoff = createBackoff()
  /** 会话级开关：某个会话可以单独关掉主动开口（全局仍开） */
  const sessionGate = new SessionGate({
    path: join(cfg.dshHome, 'leinao-sessions.json'),
    ttlDays: cfg.proactive?.sessionTtlDays,
  })
  /** 活跃会话表，由下面的 agent/created 订阅填充；会话内开关要用它兜底找当前会话 */
  let tracker

  const sessionCwd = (agent) => agent?.session?.header?.cwd

  /**
   * 按会话 id 找 agent：优先查注册表，找不到再扫 roots（有的宿主用
   * session.header.id 而不是 agent.id）。没传 id 就用最近说过话的那个。
   */
  function findAgent(sessionId) {
    const agents = ctx.agents
    if (!agents) return undefined
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : tracker?.activeId?.()
    if (!id) return undefined
    const direct = typeof agents.get === 'function' ? agents.get(id) : undefined
    if (direct !== undefined) return direct
    const roots = typeof agents.roots === 'function' ? agents.roots() : []
    return roots.find((agent) => agent.id === id || agent.session?.header?.id === id || agent.session?.id === id)
  }
  /** 最近一句用户原话：记忆索引靠它做弱命中 */
  let lastCue = ''
  let reminderTurn = null
  let reminderCount = 0

  /**
   * 读状态：先比 journal 指纹，没变就直接用内存里的；
   * 变了才重新扫 journal（外部 git pull / 别的进程写过）。
   */
  function refresh() {
    const fp = journalFingerprint(dataDir)
    if (current && fp === currentFp) return current
    current = loadState(dataDir)
    currentFp = fp
    return current
  }

  function persistNow() {
    try {
      const scan = current.scan
      saveState(dataDir, current.state, scan)
      writeProfile(dataDir, current.state, Date.now(), { mood: cfg.mood, userName: cfg.userName })
    } catch (error) {
      log.warn?.(`[leinao] 写入 state/PROFILE 失败：${error.message}`)
    }
  }

  let commitTimer = null
  function scheduleCommit(delayMs = cfg.journal.commitDebounceMs) {
    if (!cfg.journal.git) return
    if (commitTimer) return
    commitTimer = setTimeout(() => {
      commitTimer = null
      flushCommit()
    }, Math.max(0, delayMs))
    commitTimer.unref?.()
  }

  let pushTimer = null
  /** push 单独防抖：连着几轮对话只推一次，别每次都去碰网络 */
  function schedulePush() {
    if (!cfg.journal.push || !hasRemote(dataDir)) return
    if (pushTimer) return
    pushTimer = setTimeout(() => {
      pushTimer = null
      doPush()
    }, Math.max(0, cfg.journal.pushDebounceMs))
    pushTimer.unref?.()
  }

  function doPush() {
    if (!cfg.journal.push || !hasRemote(dataDir)) return
    if (!backoff.ready()) return
    const pushed = sync(dataDir, { timeout: cfg.journal.pullTimeoutMs })
    if (!pushed.ok) {
      backoff.fail(pushed.message)
      log.warn?.(`[leinao] ${pushed.message}`)
    } else {
      backoff.reset()
    }
  }

  function flushCommit() {
    if (!cfg.journal.git) return
    persistNow()
    const res = commitAll(dataDir, `leinao: ${new Date().toISOString().slice(0, 19)}Z`)
    if (!res.ok) {
      log.warn?.(`[leinao] git commit 失败：${res.message}`)
      return
    }
    if (res.code === 'nothing') return
    schedulePush()
  }

  let persistTimer = null
  function persistSoon(delayMs = cfg.mood.debounceMs) {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistNow()
      scheduleCommit()
    }, Math.max(0, delayMs))
    persistTimer.unref?.()
  }

  /** 唯一写入口：所有状态变化都从这里进 journal */
  function record(draft) {
    const { kind, when, ...payload } = draft
    const event = makeEvent(kind, deviceId, payload, when instanceof Date ? when : new Date())
    // 先把状态追到最新，再写：这样新事件能直接 apply，不用为一条事件重放整份 journal
    const base = refresh()
    appendEvent(dataDir, deviceId, event)
    const last = base.scan.events[base.scan.events.length - 1]
    const ordered = !last || event.at > last.at || (event.at === last.at && event.id > last.id)
    if (ordered && applyEvent(base.state, event)) {
      base.scan.events.push(event)
      current = base
    } else {
      // 乱序（backdate 的 when）或应用失败：老老实实全量重放
      current = loadState(dataDir, { forceRebuild: true })
    }
    currentFp = journalFingerprint(dataDir)
    persistSoon()
    if (cfg.debug) log.debug?.(`[leinao] ${kind} ${JSON.stringify(payload).slice(0, 200)}`)
    return event
  }

  // ── 记忆 ─────────────────────────────────────────────────────────────
  // 索引里被"这句话"带出来的页，记一次弱召回；同一页 6 小时内只记一次，
  // 免得每轮都刷一条事件。常被提起的事，强度会慢慢升上去。
  function noteCue(text) {
    lastCue = String(text ?? '').slice(0, 400)
    if (!lastCue) return
    const { state } = refresh()
    const index = memoryIndex(state, Date.now(), lastCue, cfg.memory)
    const now = Date.now()
    for (const item of index.selected) {
      if (item.via !== 'hit') continue
      const page = state.pages[item.path]
      if (!page) continue
      const last = page.lastRecallAt ? Date.parse(page.lastRecallAt) : 0
      if (Number.isFinite(last) && now - last < cfg.memory.weakRecallHours * 3600_000) continue
      record({ kind: 'recall', path: item.path, via: 'inject' })
    }
  }

  /**
   * 折叠提醒：只提醒，不替模型压——摘要要用当前对话的上下文写，后台拿不到。
   * 每 foldEveryTurns 轮最多提一次，一次会话最多 foldMaxPrompts 次；模型不接就停。
   */
  function foldReminder(state, now) {
    if (!(cfg.memory.foldEveryTurns > 0)) return null
    if (reminderCount >= cfg.memory.foldMaxPrompts) return null
    const turns = state.stats?.userTurns ?? 0
    if (turns === 0 || turns % cfg.memory.foldEveryTurns !== 0) return null
    if (reminderTurn === turns) return null
    const groups = foldCandidates(state, now, cfg.memory)
    if (!groups.length) return null
    reminderTurn = turns
    reminderCount += 1
    const group = groups[0]
    const more = group.paths.length > 4 ? ' 等' : ''
    return `记忆整理：标签「${group.tag}」有 ${group.paths.length} 条旧记忆可以压成一条（${group.paths.slice(0, 4).join('、')}${more}），要整理就调 persona_digest。`
  }

  // ── system prompt：人格 + 心情 + 这一档的说话方式 ───────────────────────
  ctx.systemPrompt.context({
    name: 'persona',
    order: cfg.prompt.order,
    interpolate: false,
    text: () => {
      try {
        const { state } = refresh()
        const now = Date.now()
        const index = memoryIndex(state, now, lastCue, { ...cfg.memory, subject: 'self' })
        const text = buildInjection(state, now, {
          memory: index.text,
          reminder: foldReminder(state, now),
          mood: cfg.mood,
          userName: cfg.userName,
        })
        const cap = Number(cfg.prompt.maxChars) || 0
        return cap > 0 && text.length > cap ? `${text.slice(0, Math.max(1, cap - 1))}…` : text
      } catch (error) {
        log.warn?.(`[leinao] 生成注入块失败：${error.message}`)
        return ''
      }
    },
  })

  // ── system prompt：关于老大的观察（单独一块、单独预算，可整体关掉） ─────
  ctx.systemPrompt.context({
    name: 'about-user',
    order: Number(cfg.prompt.userOrder) || 131,
    interpolate: false,
    text: () => {
      try {
        const { state } = refresh()
        if (state.phase === 'seed') return ''
        const index = memoryIndex(state, Date.now(), lastCue, {
          ...cfg.memory,
          subject: 'user',
          header: `【关于${userCall(state, cfg.userName)}】你观察到的事（不是他自己说的）：`,
        })
        const text = buildUserInjection(state, {
          memory: [observationLines(state).join('\n'), index.text].filter(Boolean).join('\n'),
        })
        const cap = Number(cfg.prompt.userMaxChars) || 0
        return cap > 0 && text.length > cap ? `${text.slice(0, Math.max(1, cap - 1))}…` : text
      } catch (error) {
        log.warn?.(`[leinao] 生成用户模型块失败：${error.message}`)
        return ''
      }
    },
  })

  // ── 主动开口 ─────────────────────────────────────────────────────────
  // 只挂 root agent：子 agent 是干活的，不该有"人格"。
  // 没有 agents 服务就安静地不开口，其余功能不受影响。
  ctx.effect?.(() => {
    const agents = ctx.agents
    if (!agents?.roots || typeof ctx.on !== 'function') return () => {}
    const trackerLocal = new ActivityTracker({ agents, logger: log })
    tracker = trackerLocal
    let off = () => {}
    try {
      off = ctx.on('agent/created', ({ agent } = {}) => {
        try {
          if (!agent) return
          if (!agents.roots().includes(agent)) return
          trackerLocal.attach(agent)
          const nudge = new ProactiveNudge(agent, {
            readConfig: () => cfg.proactive,
            getState: () => refresh().state,
            getMemory: () => cfg.memory,
            userName: () => cfg.userName,
            record,
            agents,
            tracker: trackerLocal,
            logger: log,
            lockPath: join(cfg.dshHome, 'proactive-cooldown.json'),
            pollIntervalMs: cfg.proactive?.pollIntervalMs,
            isEnabled: () => sessionGate.proactiveEnabled(agent.id, cfg.proactive?.enabled !== false, sessionCwd(agent)),
          })
          agent.ctx?.effect?.(() => {
            nudge.start()
            return () => nudge.dispose()
          })
        } catch (error) {
          log.warn?.(`[leinao] 挂主动开口失败：${error.message}`)
        }
      })
    } catch (error) {
      log.warn?.(`[leinao] 订阅 agent/created 失败：${error.message}`)
    }
    return () => {
      try {
        off?.()
      } catch {
        // 已经断了就算了
      }
      trackerLocal.dispose()
    }
  }, 'leinao.proactive()')

  // ── 会话命令 ─────────────────────────────────────────────────────────
  // `/leinao proactive on|off|status|clear`：只影响当前会话，不动全局配置。
  ctx.inject?.(['commands'], (cmdCtx) => {
    const register = () =>
      cmdCtx.commands?.register?.({
        name: 'leinao',
        description: '类脑：本会话的主动开口开关（/leinao proactive on|off|status）',
        handler: ({ agent, rawInput } = {}) => {
          try {
            const id = agent?.id
            if (!id) return { kind: 'error', text: '拿不到当前会话 id，没法记住这个开关。' }
            const arg = String(rawInput ?? '').trim().toLowerCase()
            const globalOn = cfg.proactive?.enabled !== false
            const cwd = sessionCwd(agent)
            if (!arg || arg === 'status' || arg === 'proactive status') {
              const status = sessionGate.describe(id, globalOn, cwd)
              const overrideText = status.override === undefined ? '默认' : status.override ? '显式开' : '显式关'
              const workspaceText = status.workspaceDisabled ? '，此工作区默认关' : ''
              return {
                kind: 'success',
                text: `主动开口：${status.effective ? '开' : '关'}（本会话${overrideText}${workspaceText}，全局${globalOn ? '开' : '关'}）`,
              }
            }
            if (arg === 'on' || arg === 'proactive on') {
              sessionGate.setOverride(id, true)
              return { kind: 'success', text: '本会话已允许主动开口。' }
            }
            if (arg === 'off' || arg === 'proactive off') {
              sessionGate.setOverride(id, false)
              return { kind: 'success', text: '本会话已关闭主动开口（全局配置不变）。' }
            }
            if (arg === 'clear' || arg === 'reset') {
              sessionGate.clearOverride(id)
              return { kind: 'success', text: '已清掉本会话的覆盖，回到全局默认。' }
            }
            if (arg === 'workspace off' || arg === 'workspace-off' || arg === 'workspace on' || arg === 'workspace-on') {
              const off = arg === 'workspace off' || arg === 'workspace-off'
              if (!sessionGate.setWorkspace(cwd, off)) {
                return { kind: 'error', text: '这个会话没有工作区目录，改不了工作区默认。' }
              }
              return { kind: 'success', text: off ? '此工作区默认关闭主动开口。' : '此工作区默认开启主动开口。' }
            }
            return { kind: 'error', text: '用法：/leinao proactive on | off | status | clear | workspace on | workspace off' }
          } catch (error) {
            return { kind: 'error', text: `会话开关失败：${error.message}` }
          }
        },
      })
    if (typeof cmdCtx.effect === 'function') {
      cmdCtx.effect(() => {
        const dispose = register()
        return () => dispose?.()
      }, 'leinao.command()')
    } else {
      register()
    }
  })

  // ── 设置页 ────────────────────────────────────────────────────────────
  // 客户端读写的就是 $DSH_HOME/leinao.json；写完 reload 把 cfg 就地更新，下一轮生效。
  // dataDir / deviceId / prompt.order / journal.git 启动时已经定下，UI 上标「需重启」。
  function reloadConfig() {
    Object.assign(cfg, loadConfig(inlineConfig))
    log.info?.(`[leinao] 配置已重载：${cfg.configFile}`)
  }

  installSettingsApi(ctx, {
    file: cfg.configFile,
    getConfig: () => cfg,
    getDefaults: () => DEFAULT_CONFIG,
    reload: reloadConfig,
    status: () => {
      const stats = memoryStats(current.state)
      return {
        phase: current.state.phase,
        turns: current.state.stats?.userTurns ?? 0,
        events: current.state.stats?.events ?? 0,
        deviceId,
        dataDir,
        memories: memoryStats(current.state, 'self').visible,
        userMemories: memoryStats(current.state, 'user').visible,
        observations: observationStats(current.state).count,
        folded: stats.folded,
        health: buildHealth(current.state, Date.now(), { memory: cfg.memory }),
        enabled: cfg.enabled,
      }
    },
    overridden: () => Object.keys(inlineConfig ?? {}),
    log,
  })

  installSessionApi(ctx, {
    gate: sessionGate,
    resolveAgent: findAgent,
    globalEnabled: () => cfg.proactive?.enabled !== false,
    log,
  })

  installGraphApi(ctx, {
    getGraph: () => buildGraph(refresh().state, Date.now(), { memory: cfg.memory }),
    log,
  })

  installUserModelApi(ctx, {
    getModel: () => buildUserModel(refresh().state),
    dropObservation: (key) => record({ kind: 'observation-drop', key }),
    clearObservations: () => record({ kind: 'observation-clear' }),
    forgetPage: (path) => record({ kind: 'forget', path, why: '用户模型里删除' }),
    log,
  })

  // ── 对话 → 心情 ───────────────────────────────────────────────────────
  // 只认 source.kind === 'user'：skill 注入、goal 续跑、文件变更通知都不是"老大说话"。
  //
  // 裂痕的缓和走对话本身：用户道歉/示好、或自己道歉，都会自动记一条 mend 事件，
  // 把热度一点点浇灭。不需要谁去点"修复"按钮，但也不会凭空自己好。
  function mendFrom(text, role) {
    const { state } = refresh()
    if (!state.bond?.rift) return
    const signal = detectMend(text, role)
    if (!signal) return
    record({ kind: 'bond', action: 'mend', delta: signal.delta, why: signal.why, role })
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text) mendFrom(text, 'assistant')
        return
      }
      if (event?.type !== 'user/message') return
      const data = event.data ?? {}
      if (data.source?.kind !== 'user') return
      const text = textOf(data.content)
      if (!text) return
      evidence.remember(text)
      mendFrom(text, 'user')

      const { state } = refresh()
      if (state.phase !== 'active') return

      const now = Date.now()
      const prevAt = state.stats?.lastEventAt ? Date.parse(state.stats.lastEventAt) : null
      const signal = appraise({ text, role: 'user', at: now, prevAt })
      record({
        kind: 'affect',
        when: new Date(now),
        signal: { v: signal.v, e: signal.e, t: signal.t },
        why: signal.why,
        role: 'user',
      })
      noteCue(text)
    } catch (error) {
      log.warn?.(`[leinao] 处理对话事件失败：${error.message}`)
    }
  })

  // ── 工具 ─────────────────────────────────────────────────────────────
  void (async () => {
    let defineTool = defineToolOverride
    if (!defineTool) {
      try {
        ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
      } catch {
        log.warn?.('[leinao] 没有 @deepseek-ai/dsh-tools，工具注册跳过（注入仍然生效）')
        return
      }
    }
    try {
      registerPersonaTools(ctx, defineTool, {
        dataDir,
        deviceId,
        refresh,
        record,
        verifyEvidence: evidence.verify,
        getConfig: () => cfg,
        render: (state) => renderProfile(state, Date.now(), { mood: cfg.mood, userName: cfg.userName }),
        writeExport: (text) => {
          const file = join(paths.view, 'EXPORT.md')
          writeFileAtomic(file, text)
          return file
        },
        writeUserModel: (state) => writeUserModel(dataDir, state, Date.now(), { mood: cfg.mood, userName: cfg.userName }),
        userName: () => cfg.userName,
      })
      log.info?.('[leinao] 工具已注册：persona_state / persona_seed / persona_pin / persona_bond / persona_shift / persona_remember / persona_observe / persona_recall / persona_digest / persona_forget / persona_reset / persona_export')
    } catch (error) {
      log.warn?.(`[leinao] 工具注册失败：${error.message}`)
    }
  })()

  // 启动时把已有 journal 落成 state + PROFILE（首次运行会生成 view/PROFILE.md）
  persistNow()
  scheduleCommit(1_500)

  ctx.effect?.(() => () => {
    if (persistTimer) clearTimeout(persistTimer)
    if (commitTimer) clearTimeout(commitTimer)
    if (pushTimer) clearTimeout(pushTimer)
    persistNow()
    if (cfg.journal.git) {
      commitAll(dataDir, 'leinao: shutdown flush')
      doPush()
    }
  })

  log.info?.(`[leinao] 就绪：${dataDir}（设备 ${deviceId}，阶段 ${current.state.phase}）`)
}

// 两种 inject 声明方式都写上：bundle loader 读 apply.inject，cordis 也认命名导出。
apply.inject = inject

export default apply
