/**
 * 记忆健康：给「现在的记忆库」做一次体检，出个 0–100 的分数和几条可执行的建议。
 *
 * 只看重放后的状态，不读盘、不发请求——所以设置页每刷新一次就是最新的，
 * 和 dsh-memory lint 那些事后脚本不同，这里没有「跑没跑过」的问题。
 */
import { MEMORY, isVisible, memoryIndex, memoryStats, strengthOf } from './memory.js'
import { observationList } from './observations.js'

export const HEALTH = {
  staleDays: 90,
  staleStrength: 0.4,
  lonelyWarn: 0.4,
  observationWarn: 40,
  confidentMin: 0.5,
  foldWarn: 0.5,
}

const DAY = 86400000

const pct = (value) => `${Math.round(value * 100)}%`

const gradeOf = (score) => {
  if (score >= 85) return '健康'
  if (score >= 70) return '还行'
  if (score >= 50) return '偏乱'
  return '该整理了'
}

/**
 * @param {object} state 重放后的状态
 * @param {number} [nowMs]
 * @param {{ memory?: object }} [options]
 */
export function buildHealth(state, nowMs = Date.now(), options = {}) {
  const memory = { ...MEMORY, ...(options.memory ?? {}) }
  const stats = memoryStats(state)
  const visible = Object.values(state?.pages ?? {}).filter((page) => isVisible(page))
  const observations = observationList(state)
  const checks = []

  if (visible.length === 0) {
    return {
      score: 100,
      grade: '还没开始',
      checks: [{ id: 'empty', label: '还没有记忆', ok: true, detail: '先记两页，这里才有东西可看。' }],
      freshness: { today: 0, week: 0, month: 0, quarter: 0, older: 0, never: 0 },
      stale: [],
      size: { pages: 0, observations: observations.length, chars: 0 },
    }
  }

  // 1) 索引是不是被塞满了 —— 塞满说明该折叠了，不然每轮都在挤预算。
  const index = memoryIndex(state, nowMs, '', memory)
  const indexFull = index.lines.length >= memory.indexMaxLines
  checks.push({
    id: 'index',
    label: '索引预算',
    ok: !indexFull,
    detail: indexFull
      ? `索引 ${index.lines.length}/${memory.indexMaxLines} 行已满，记得折叠或提高上限。`
      : `索引 ${index.lines.length}/${memory.indexMaxLines} 行，还有余量。`,
  })

  // 2) 关系：孤点太多说明记得散，召回时带不出上下文。
  const lonelyShare = stats.visible ? stats.isolated / stats.visible : 0
  checks.push({
    id: 'links',
    label: '页间关系',
    ok: lonelyShare <= HEALTH.lonelyWarn,
    detail: lonelyShare === 0
      ? '每一页都连上了。'
      : `${stats.isolated}/${stats.visible} 页是孤点（${pct(lonelyShare)}），记的时候顺手写 links。`,
  })

  // 3) 新鲜度：多久没更新了 —— 全是很久以前的页，说明只在吃老本。
  const freshness = { today: 0, week: 0, month: 0, quarter: 0, older: 0, never: 0 }
  for (const page of visible) {
    const ts = Date.parse(page.updatedAt ?? page.at ?? '')
    if (!Number.isFinite(ts)) {
      freshness.never += 1
      continue
    }
    const days = (nowMs - ts) / DAY
    if (days < 1) freshness.today += 1
    else if (days <= 7) freshness.week += 1
    else if (days <= 30) freshness.month += 1
    else if (days <= 90) freshness.quarter += 1
    else freshness.older += 1
  }
  const freshShare = visible.length ? Math.min(1, (freshness.today + freshness.week + freshness.month) / visible.length) : 0
  checks.push({
    id: 'fresh',
    label: '新鲜度',
    ok: freshShare >= 0.5,
    detail: `90 天内更新过的占 ${pct(freshShare)}，更早的 ${freshness.older + freshness.quarter} 页。`,
  })

  // 4) 整理页别占太多 —— 折叠是为了省预算，不是为了把记忆压成渣。
  const foldShare = stats.visible ? (stats.folded ?? 0) / stats.visible : 0
  checks.push({
    id: 'fold',
    label: '整理比例',
    ok: foldShare <= HEALTH.foldWarn,
    detail: `整理页 ${stats.folded ?? 0}/${stats.visible}（${pct(foldShare)}）。`,
  })

  // 5) 用户模型：观察太多会喧宾夺主，太不确定的又没参考价值。
  const confident = observations.filter((item) => (item.confidence ?? 0) >= HEALTH.confidentMin).length
  const confidenceShare = observations.length ? confident / observations.length : 1
  const observationOk = observations.length <= HEALTH.observationWarn && confidenceShare >= 0.5
  checks.push({
    id: 'observations',
    label: '用户模型',
    ok: observationOk,
    detail: observations.length === 0
      ? '还没有观察，画像还是空的。'
      : `${observations.length} 条观察，较确定 ${confident} 条（${pct(confidenceShare)}）。`,
  })

  const weights = { index: 20, links: 20, fresh: 20, fold: 15, observations: 25 }
  let score = 0
  for (const check of checks) {
    const weight = weights[check.id] ?? 0
    score += check.ok ? weight : Math.round(weight * 0.4)
  }

  const stale = visible
    .map((page) => {
      const ts = Date.parse(page.updatedAt ?? page.at ?? '')
      const days = Number.isFinite(ts) ? Math.floor((nowMs - ts) / DAY) : null
      return { path: page.path, title: page.title ?? page.path, days, strength: strengthOf(page, nowMs, memory) }
    })
    .filter((item) => (item.days === null || item.days >= HEALTH.staleDays) && item.strength < HEALTH.staleStrength)
    .sort((a, b) => a.strength - b.strength)
    .slice(0, 5)

  return {
    score: Math.max(0, Math.min(100, score)),
    grade: gradeOf(score),
    checks,
    freshness,
    stale,
    size: {
      pages: stats.visible,
      observations: observations.length,
      chars: visible.reduce((sum, page) => sum + String(page.content ?? '').length + String(page.gist ?? '').length, 0),
    },
  }
}
