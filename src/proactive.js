/**
 * 主动 followup：对话安静下来之后，让类脑自己想起一件事，主动说一句。
 *
 * 和记忆插件那套一样，只有三个零件：
 * 1. 每个 root agent 挂一个守卫：`agent.ctx.on('agent/turn-stopping')` + 轮询（完全空闲的
 *    agent 不再产生 turn 事件，光靠事件会永远等不到）；
 * 2. 发消息前过几道闸：agent 还活着、idle、inbox 没有排队的下一步、用户真的说过话、
 *    只对「最近在说话的那个会话」开口、每次会话有上限、两次之间有随机间隔；
 * 3. 跨插件礼貌锁：抢 `<dshHome>/proactive-cooldown.json`，别的主动插件刚说完话就让一让。
 *
 * 内容只用已有记忆：挑一条强度够、还没被主动提过的页；挑不出来就不说话。
 * 主动开口宁缺毋滥——一句"今天还在忙吗"比硬塞一段回忆更像人。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isVisible, strengthOf, subjectOf } from './memory.js'

export const PROACTIVE = {
  /** 两次主动开口之间的随机间隔（分钟） */
  minMinutes: 40,
  maxMinutes: 120,
  /** 一次会话最多主动开口几次 */
  maxPerSession: 2,
  /** 主动消息的共享冷却（秒），别的插件刚说过话就等下一轮 */
  cooldownSeconds: 180,
  /** 轮询间隔：idle 的 agent 不会产生 turn 事件 */
  pollIntervalMs: 30_000,
  /** 低于这个强度的页不主动提，免得翻旧账 */
  minStrength: 0.35,
  /** 主动提过之后至少隔多少天再提同一条 */
  rementionDays: 14,
}

export function randomIntervalMs(minMinutes, maxMinutes) {
  const min = Math.max(0, Number(minMinutes ?? PROACTIVE.minMinutes))
  const max = Math.max(min, Number(maxMinutes ?? min))
  return (min + Math.random() * (max - min)) * 60000
}

/**
 * 挑一条值得主动提的旧记忆：强度够、不是刚提过、越久没被想起越优先。
 * 没有合适的就返回 null——沉默是允许的。
 */
export function pickRecallPage(state, nowMs = Date.now(), options = {}) {
  const minStrength = Number(options.minStrength ?? PROACTIVE.minStrength)
  const rementionMs = Math.max(0, Number(options.rementionDays ?? 14)) * 86400000
  const strengthOptions = options.memory ?? {}
  const candidates = []
  for (const page of Object.values(state?.pages ?? {})) {
    // 只主动提「我自己的记忆」；用户模型是观察，不适合拿来当寒暄素材
    if (!isVisible(page) || subjectOf(page) !== 'self') continue
    const strength = strengthOf(page, nowMs, strengthOptions)
    if (strength < minStrength) continue
    const lastSeen = Date.parse(page.lastRecallAt ?? '')
    if (Number.isFinite(lastSeen) && rementionMs > 0 && nowMs - lastSeen < rementionMs) continue
    candidates.push({ page, strength, lastSeen: Number.isFinite(lastSeen) ? lastSeen : 0 })
  }
  candidates.sort((a, b) => b.strength - a.strength || a.lastSeen - b.lastSeen)
  return candidates[0]?.page ?? null
}

/** 主动开口的文案：给材料 + 边界，让当前对话里的模型自己决定怎么说 */
export function buildRecallMessage(page, profile = {}) {
  const agentName = String(profile?.name ?? '').trim() || '我'
  const userName = String(profile?.userCall ?? '').trim() || '你'
  const gist = String(page?.gist ?? '').trim() || String(page?.content ?? '').split('\n')[0] || ''
  return {
    id: `leinao-recall-${randomUUID()}`,
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          `【${agentName}主动想起】对话空了一会儿。你忽然想起关于${userName}的一件事：${page?.title ?? '一件旧事'}${gist ? `——${gist}` : ''}。`,
          `合适就用「${agentName}」自己的口吻自然提一句（我记得 / 上次你说…），一句到三句；`,
          '不合适就只说一句日常状态带过，别硬提，也别念成汇报。',
          '不要编记忆里没有的细节；对方没接就放下这个话题。',
        ].join('\n'),
      },
    ],
    source: { kind: 'plugin:leinao' },
  }
}

/**
 * 跨插件礼貌锁：文件 `<dshHome>/proactive-cooldown.json`，内容 `{version:1, speaker, at}`。
 * 写失败/文件坏了都当成"没有锁"，不让仲裁拖垮消息。
 */
export function claimProactiveLock({ path, speaker, cooldownSeconds = PROACTIVE.cooldownSeconds, now = Date.now() }) {
  if (!path) return { ok: true }
  if (Number(cooldownSeconds) <= 0) return { ok: true }
  let held = null
  try {
    if (existsSync(path)) held = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    held = null
  }
  if (held && typeof held.at === 'number' && Number.isFinite(held.at)) {
    const elapsed = now - held.at
    if (elapsed >= 0 && elapsed < Number(cooldownSeconds) * 1000 && held.speaker !== speaker) {
      return { ok: false, deferredBy: String(held.speaker ?? 'someone') }
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, speaker, at: now })}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // 锁只是礼貌，不是闸门；写不进去就照常说话。
  }
  return { ok: true }
}

/** 每个会话记住"用户说过话"与"最近说话的会话"，避免对没人理的后台会话开口 */
class ActivityTracker {
  constructor({ agents, logger } = {}) {
    this.agents = agents
    this.logger = logger
    this.states = new Map()
    this.seq = 0
  }

  attach(agent) {
    const existing = this.states.get(agent.id)
    if (existing && existing.agent === agent) return
    const entry = { agent, hasUserSpoken: false, lastUserSeq: 0, stop: undefined }
    entry.stop = agent.ctx?.on?.('agent/inbox/inserted', ({ message }) => {
      if (message?.source?.kind === 'user') {
        entry.hasUserSpoken = true
        entry.lastUserSeq = ++this.seq
      }
    })
    this.states.set(agent.id, entry)
  }

  isActive(id) {
    const entry = this.states.get(id)
    if (!entry?.hasUserSpoken) return false
    let winner
    let latest = 0
    for (const [agentId, state] of this.states) {
      if (!state.hasUserSpoken) continue
      const alive = typeof this.agents?.get === 'function' ? this.agents.get(agentId) !== undefined : true
      if (!alive) continue
      if (state.lastUserSeq > latest) {
        latest = state.lastUserSeq
        winner = agentId
      }
    }
    return winner === id
  }

  shouldInject(id) {
    const entry = this.states.get(id)
    if (!entry?.hasUserSpoken) return false
    return this.states.size === 1 || this.isActive(id)
  }

  dispose() {
    for (const entry of this.states.values()) {
      try {
        entry.stop?.()
      } catch (error) {
        this.logger?.warn?.(`[leinao] 解绑会话监听失败：${error.message}`)
      }
    }
    this.states.clear()
  }
}

export { ActivityTracker }

/**
 * 每个 root agent 一个守卫，生命周期挂在 agent.ctx 上。
 */
export class ProactiveNudge {
  constructor(agent, options = {}) {
    this.agent = agent
    this.readConfig = options.readConfig ?? (() => PROACTIVE)
    this.getState = options.getState ?? (() => undefined)
    this.record = options.record
    this.isEnabled = options.isEnabled
    this.agents = options.agents
    this.tracker = options.tracker
    this.logger = options.logger
    this.lockPath = options.lockPath
    this.pollIntervalMs = options.pollIntervalMs ?? PROACTIVE.pollIntervalMs
    this.sent = 0
    this.nextAt = 0
    this.disposed = false
    this.stopTurnStopping = undefined
    this.timer = undefined
  }

  start() {
    if (this.disposed) return
    this.stopTurnStopping = this.agent.ctx?.on?.('agent/turn-stopping', () => this.safeCheck())
    this.timer = setInterval(() => this.safeCheck(), this.pollIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  dispose() {
    this.disposed = true
    try {
      this.stopTurnStopping?.()
    } catch {
      // 已经断了就算了
    }
    this.stopTurnStopping = undefined
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  safeCheck() {
    if (this.disposed) return
    try {
      this.onTurnStopped()
    } catch (error) {
      this.logger?.warn?.(`[leinao] 主动开口检查失败（${this.agent?.id}）：${error.message}`)
    }
  }

  /** 到点没到点、该不该开口，全在这里判断 */
  onTurnStopped() {
    if (this.disposed) return
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return
    }
    const config = { ...PROACTIVE, ...(this.readConfig() ?? {}) }
    if (config.enabled === false) return
    if (this.isEnabled && !this.isEnabled()) return
    if (this.sent >= Math.max(1, Number(config.maxPerSession ?? PROACTIVE.maxPerSession))) return
    if (this.tracker && !this.tracker.shouldInject(this.agent.id)) return
    if (this.agent.status !== 'idle') return
    const inbox = this.agent.inbox
    if (inbox && Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return

    const now = Date.now()
    if (this.nextAt === 0) {
      // 第一个空闲点只校准节奏，不立刻开口
      this.nextAt = now + randomIntervalMs(config.minMinutes, config.maxMinutes)
      return
    }
    if (now < this.nextAt) return

    const state = this.getState()
    const page = pickRecallPage(state, now, config)
    if (!page) return

    const claim = claimProactiveLock({
      path: this.lockPath,
      speaker: 'leinao',
      cooldownSeconds: config.cooldownSeconds,
      now,
    })
    if (!claim.ok) {
      this.logger?.info?.(`[leinao] 主动开口让给 ${claim.deferredBy}，下一轮再试`)
      return
    }

    this.agent.followup(buildRecallMessage(page, state?.profile))
    this.sent += 1
    this.nextAt = now + randomIntervalMs(config.minMinutes, config.maxMinutes)
    try {
      // 记一次召回：同一条以后不会反复被主动提起，也会让它在索引里更稳
      this.record?.({ kind: 'recall', path: page.path, via: 'proactive' })
    } catch (error) {
      this.logger?.warn?.(`[leinao] 记录主动召回失败：${error.message}`)
    }
    this.logger?.info?.(`[leinao] 主动想起「${page.title}」（第 ${this.sent} 次）`)
  }
}
