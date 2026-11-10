/**
 * 会话级 / 工作区级开关：全局开着的时候，仍然允许单个会话或某个目录说
 * "这儿别主动开口"。
 *
 * 优先级：全局 `proactive.enabled` > 会话覆盖 > 工作区默认 > 默认开。
 * 落在 `<dshHome>/leinao-sessions.json`：
 *   { version: 1, sessions: { [id]: { proactive, at } }, workspaces: { [cwd]: { proactive, at } } }
 * 会话条目带时间戳、超过 TTL 自动清掉——免得几个月后翻出一堆早已结束的会话；
 * 工作区条目是长期偏好，不参与 TTL。
 *
 * 文件坏了/写不进去都按"没有覆盖"处理：开关是偏好，不该拖垮对话。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const SESSIONS = { ttlDays: 7, version: 1 }

export class SessionGate {
  constructor({ path, ttlDays = SESSIONS.ttlDays, now = () => Date.now() } = {}) {
    this.path = path
    this.ttlDays = Math.max(0, Number(ttlDays ?? SESSIONS.ttlDays))
    this.now = now
    this.data = this.read()
    this.prune()
  }

  read() {
    const empty = { version: SESSIONS.version, sessions: {}, workspaces: {} }
    if (!this.path || !existsSync(this.path)) return empty
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      const sessions = parsed?.sessions
      const workspaces = parsed?.workspaces
      return {
        version: SESSIONS.version,
        sessions: sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {},
        workspaces: workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces) ? workspaces : {},
      }
    } catch {
      return empty
    }
  }

  /** 过期条目直接丢掉；TTL=0 表示永不过期 */
  prune() {
    if (!this.ttlDays) return
    const cutoff = this.now() - this.ttlDays * 86400000
    let changed = false
    for (const [id, entry] of Object.entries(this.data.sessions)) {
      const at = Date.parse(entry?.at ?? '')
      if (!Number.isFinite(at) || at < cutoff) {
        delete this.data.sessions[id]
        changed = true
      }
    }
    if (changed) this.write()
  }

  write() {
    if (!this.path) return false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.path)
      return true
    } catch {
      return false
    }
  }

  /** 没设过覆盖时返回 undefined，调用方好区分「默认」和「显式开/关」 */
  getOverride(sessionId) {
    if (!sessionId) return undefined
    const entry = this.data.sessions[sessionId]
    return typeof entry?.proactive === 'boolean' ? entry.proactive : undefined
  }

  setOverride(sessionId, enabled) {
    if (!sessionId) return false
    this.data.sessions[sessionId] = {
      proactive: Boolean(enabled),
      at: new Date(this.now()).toISOString(),
    }
    return this.write()
  }

  clearOverride(sessionId) {
    if (!sessionId || !this.data.sessions[sessionId]) return false
    delete this.data.sessions[sessionId]
    return this.write()
  }

  /** 工作区默认关：没配置过的目录返回 false（即默认开） */
  getWorkspaceDisabled(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return false
    return this.data.workspaces[cwd]?.proactive === false
  }

  /** 记住某个目录默认关/默认开；cwd 为空时返回 false（调用方好回 400） */
  setWorkspace(cwd, disabled) {
    if (typeof cwd !== 'string' || cwd.length === 0) return false
    this.data.workspaces[cwd] = {
      proactive: !disabled,
      at: new Date(this.now()).toISOString(),
    }
    this.write()
    return true
  }

  /** 全局关掉时，会话/工作区覆盖说什么都没用；显式会话覆盖压过工作区默认 */
  proactiveEnabled(sessionId, globalEnabled = true, cwd) {
    if (globalEnabled === false) return false
    const override = this.getOverride(sessionId)
    if (override !== undefined) return override
    return !this.getWorkspaceDisabled(cwd)
  }

  describe(sessionId, globalEnabled = true, cwd) {
    const override = this.getOverride(sessionId)
    return {
      sessionId,
      cwd,
      globalEnabled: globalEnabled !== false,
      override,
      workspaceDisabled: this.getWorkspaceDisabled(cwd),
      effective: this.proactiveEnabled(sessionId, globalEnabled, cwd),
    }
  }
}
