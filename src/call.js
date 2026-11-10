/**
 * 怎么称呼用户：seed 时记的 `profile.userCall` 优先，其次配置里的 `userName`。
 *
 * 早先版本把「老大」写死在注入和工具文案里——自己用没问题，给别人用就不对。
 * 现在所有对外文案都从这里取，默认值只是兜底。
 */
export const DEFAULT_USER_CALL = '老大'

export function userCall(state, fallback = '') {
  const recorded = state?.profile?.userCall
  if (typeof recorded === 'string' && recorded.trim()) return recorded.trim()
  const configured = String(fallback ?? '').trim()
  return configured || DEFAULT_USER_CALL
}
