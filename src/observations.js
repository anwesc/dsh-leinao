/**
 * 用户模型的「观察」：不是叙事长文，是一条条有证据的短事实。
 *
 * - 存在事件流的 observation 事件里，重放后按 key 取最新一条；
 * - 每条都必须带用户原话 evidence（写入时由工具核验，重放时只做格式校验）；
 * - 注入时只取置信度最高的几条，避免用户模型挤掉人格记忆的预算。
 */

export const OBSERVATION = {
  maxKeyChars: 40,
  maxValueChars: 120,
  maxLines: 4,
  minEvidenceChars: 4,
}

/** key 是稳定短标签（如「作息」「口味」）；空白折叠成一个空格 */
export function normalizeObservationKey(value) {
  const key = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!key) return ''
  return key.length <= OBSERVATION.maxKeyChars ? key : ''
}

/** 全部观察，置信度高在前，同分看更新时间 */
export function observationList(state) {
  return Object.values(state?.observations ?? {}).sort((a, b) => {
    const byConfidence = (b.confidence ?? 0) - (a.confidence ?? 0)
    if (byConfidence !== 0) return byConfidence
    return Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '')
  })
}

/** 注入用：一行一条，低置信度的标出来，别当事实 */
export function observationLines(state, { limit = OBSERVATION.maxLines } = {}) {
  return observationList(state)
    .slice(0, Math.max(0, limit))
    .map((item) => `- ${item.key}：${item.value}${(item.confidence ?? 1) < 0.5 ? '（不太确定）' : ''}`)
}

export function observationStats(state) {
  const all = Object.values(state?.observations ?? {})
  return {
    count: all.length,
    confident: all.filter((item) => (item.confidence ?? 0) >= 0.5).length,
  }
}
