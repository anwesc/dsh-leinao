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
import { ensureDirs, loadState, personaPaths, saveState, writeFileAtomic } from './src/store.js'
import { renderProfile, writeProfile, writeUserModel } from './src/render.js'
import { buildInjection, buildUserInjection } from './src/prompt.js'
import { observationLines, observationStats } from './src/observations.js'
import { appraise } from './src/appraisal.js'
import { registerPersonaTools } from './src/tools.js'
import { detectMend } from './src/bond.js'
import { foldCandidates, memoryIndex, memoryStats } from './src/memory.js'
import { installSettingsApi } from './src/settings.js'
import { SHIFT } from './src/traits.js'
import { commitAll, createBackoff, ensureRepo, hasRemote, sync } from './src/git.js'

export const name = 'persona'
export const inject = ['tools', 'systemPrompt']

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
  const evidence = createEvidenceCheck()
  const backoff = createBackoff()
  /** 最近一句用户原话：记忆索引靠它做弱命中 */
  let lastCue = ''
  let reminderTurn = null
  let reminderCount = 0

  /** 状态缓存失效就重放；命中缓存时只扫一遍 journal（数据量小，够用） */
  function refresh() {
    current = loadState(dataDir)
    return current
  }

  function persistNow() {
    try {
      const scan = current.scan
      saveState(dataDir, current.state, scan)
      writeProfile(dataDir, current.state, Date.now(), { mood: cfg.mood })
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
    appendEvent(dataDir, deviceId, event)
    current = loadState(dataDir, { forceRebuild: true })
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
          header: '【关于老大】你观察到的事（不是他自己说的）：',
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
        memories: stats.visible,
        userMemories: memoryStats(current.state, 'user').visible,
        observations: observationStats(current.state).count,
        folded: stats.folded,
        enabled: cfg.enabled,
      }
    },
    overridden: () => Object.keys(inlineConfig ?? {}),
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
        render: (state) => renderProfile(state, Date.now(), { mood: cfg.mood }),
        writeExport: (text) => {
          const file = join(paths.view, 'EXPORT.md')
          writeFileAtomic(file, text)
          return file
        },
        writeUserModel: (state) => writeUserModel(dataDir, state, Date.now(), { mood: cfg.mood }),
      })
      log.info?.('[leinao] 工具已注册：persona_state / persona_seed / persona_pin / persona_bond / persona_shift / persona_remember / persona_recall / persona_digest / persona_forget / persona_reset / persona_export')
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
