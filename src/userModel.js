/**
 * 用户模型的可管理视图：观察 + 标了 subject:'user' 的记忆页。
 *
 * 这里只做读，不做写——写仍然走事件（observation / forget），
 * 这样 UI 上删掉的东西在 journal 里也留痕，重放能重建。
 */
import { isVisible, subjectOf } from './memory.js'
import { observationList } from './observations.js'

export const USER_MODEL = { maxPages: 50 }

/** 给设置页「用户模型」卡用的快照：观察按置信度排，页按更新时间排 */
export function buildUserModel(state) {
  const observations = observationList(state).map((item) => ({
    key: item.key,
    value: item.value,
    confidence: Number(item.confidence ?? 0),
    evidence: item.evidence ?? null,
    at: item.at ?? null,
    updatedAt: item.updatedAt ?? null,
  }))
  const pages = Object.values(state?.pages ?? {})
    .filter((page) => isVisible(page) && subjectOf(page) === 'user')
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, USER_MODEL.maxPages)
    .map((page) => ({
      path: page.path,
      title: page.title,
      gist: page.gist ?? null,
      tags: Array.isArray(page.tags) ? page.tags : [],
      updatedAt: page.updatedAt ?? null,
    }))
  return {
    observations,
    pages,
    counts: {
      observations: observations.length,
      confident: observations.filter((item) => item.confidence >= 0.5).length,
      pages: pages.length,
    },
  }
}
