/**
 * 写记忆的轻提醒。
 *
 * 插件不会自己写记忆，全靠模型在对话里判断。这里只做一件事：
 * 用户这句话像「长期约定 / 偏好 / 边界」时，在下一轮注入里提一句
 * 「要不要记一条」，而且只提一次、不按次数硬掐。
 *
 * 三条护栏（都比设一个拍脑袋的次数上限有用）：
 *   1. 同一类信号本会话只提一次——提过「偏好」就不再提「偏好」；
 *   2. 提醒后冷却一段时间，免得密集对话里反复提；
 *   3. 最近已经写过记忆就不提——说明模型有记的习惯，不用催。
 */

export const REMIND = {
  cooldownMinutes: 30,
  recentWriteHours: 24,
  maxPerSession: 0, // 0 = 不限
}

/** 信号表：先匹配先得，key 用来去重 */
export const SIGNALS = [
  { key: 'future-rule', label: '「以后 / 下次 / 每次都」这类约定', re: /以后|下次|每次|今后|从今/ },
  { key: 'preference', label: '你的偏好', re: /我(比较|更)?喜欢|我不喜欢|我习惯|我讨厌|我偏好|我更想/ },
  { key: 'boundary', label: '「别再 / 不要」这类边界', re: /别再|不要再|不用再|别总|不许|不要总/ },
  { key: 'remember', label: '你说要记住的事', re: /记住|记一下|记得|别忘了/ },
]

/**
 * @param {string} text 用户原话
 * @returns {{key:string,label:string}|null}
 */
export function detectMemorySignal(text) {
  const value = String(text ?? '')
  if (!value.trim()) return null
  for (const signal of SIGNALS) {
    if (signal.re.test(value)) return { key: signal.key, label: signal.label }
  }
  return null
}

/**
 * @param {object} input
 * @param {string} input.signalKey
 * @param {number} [input.lastNudgeAt] 上次提醒时间
 * @param {Set<string>|string[]} [input.nudgedKeys] 本会话已提过的信号
 * @param {number|null} [input.lastWriteAt] 最近一次写记忆的时间
 * @param {number} input.now
 * @param {object} [input.config] memory 段配置
 * @param {number} [input.count] 本会话已提醒次数
 * @returns {boolean}
 */
export function shouldNudge({ signalKey, lastNudgeAt = 0, nudgedKeys, lastWriteAt = null, now = Date.now(), config = {}, count = 0 }) {
  if (config.nudgeEnabled === false) return false
  const seen = nudgedKeys instanceof Set ? nudgedKeys : new Set(nudgedKeys ?? [])
  if (seen.has(signalKey)) return false

  const cooldownMs = Math.max(0, Number(config.nudgeCooldownMinutes ?? REMIND.cooldownMinutes)) * 60_000
  if (lastNudgeAt && now - lastNudgeAt < cooldownMs) return false

  const recentMs = Math.max(0, Number(config.nudgeRecentWriteHours ?? REMIND.recentWriteHours)) * 3_600_000
  if (lastWriteAt && recentMs > 0 && now - lastWriteAt < recentMs) return false

  const max = Math.max(0, Number(config.nudgeMaxPerSession ?? REMIND.maxPerSession))
  if (max > 0 && count >= max) return false

  return true
}

/** 注入里那行提醒；只给动作，不替模型判断 */
export function nudgeLine(label) {
  return `【记忆】这句像${label}，值得长期记住就用 persona_remember 记一条页；如果只是闲聊，不用记。`
}

/**
 * 自动草稿：同一类信号短时间内出现两次，说明不是随口一说，
 * 插件自己记一条低置信度观察（value 用原话摘录，evidence 用原话），
 * 在用户模型卡里可见可删。不向对话里发任何消息。
 */
export const AUTO = {
  windowMinutes: 10,
  minCount: 2,
  confidence: 0.4,
  maxValueChars: 120,
  maxEvidenceChars: 200,
}

export const AUTO_KEYS = {
  'future-rule': '约定',
  preference: '偏好',
  boundary: '边界',
  remember: '要记住',
}

/** 自动写进 journal 的东西不会自动消失，敏感信息在入口就挡住 */
export const SENSITIVE = [
  /sk-[A-Za-z0-9_-]{8,}/,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
  /(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/i,
  /\b\d{17}[\dXx]\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function hasSensitive(text) {
  const raw = String(text ?? '')
  return SENSITIVE.some((pattern) => pattern.test(raw))
}

export function autoDraft(signal, text) {
  const raw = String(text ?? '').trim()
  // 命中敏感信息就不自动记：宁可漏一条，也不把密钥写进 journal / USER.md
  if (hasSensitive(raw)) return null
  const value = raw.replace(/\s+/g, ' ').slice(0, AUTO.maxValueChars)
  return {
    key: AUTO_KEYS[signal.key] ?? signal.label,
    value,
    evidence: raw.slice(0, AUTO.maxEvidenceChars),
    confidence: AUTO.confidence,
  }
}
