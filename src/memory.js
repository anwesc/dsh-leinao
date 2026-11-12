/**
 * 记忆：索引挑选、强度衰减、折叠候选、检索。
 *
 * 三层：
 *   内容 —— journal 里的 page 事件（append-only，真源）
 *   索引 —— 每轮注入的几行，按「固定 / 强度 / 命中」挑
 *   强度 —— 这里按 now 算，不落盘：同一份 journal 在不同时刻渲染出不同索引，
 *           但重放出来的 state 永远一样（和心情衰减同一套哲学）。
 *
 * 这个文件是纯函数：不读文件、不写事件、不调模型。
 */

export const MEMORY = {
  /** 强度减半天数 */
  halfLifeDays: 21,
  /** 分级权重；salience 1 直接恒为 1，不走衰减 */
  salienceWeight: { 1: 1, 2: 0.6, 3: 0.3 },
  /** 每次被召回加一点强度，避免"重要的东西因为没人问就被埋掉" */
  recallBonus: 0.15,
  recallBonusCap: 0.45,
  /** 索引：最多几行、总字数、单行字数 */
  indexMaxLines: 5,
  indexMaxChars: 400,
  lineMaxChars: 68,
  /** 强度 ≥ 此值常驻索引 */
  strongThreshold: 0.5,
  /** 强度低于此值退出索引，只能显式召回 */
  hideBelow: 0.2,
  /** 折叠：多久没召回、强度低到多少、同 tag 至少几条 */
  foldAfterDays: 30,
  foldBelowStrength: 0.4,
  foldMinGroup: 3,
  /** 注入命中后，多久内不重复记 recall（避免刷事件） */
  weakRecallHours: 6,
  /** 折叠提醒：每多少轮提一次、一次会话最多提几次 */
  foldEveryTurns: 30,
  foldMaxPrompts: 3,
  /** 单条正文上限 */
  contentMaxChars: 2000,
}

const DAY_MS = 86400000

export function normalizeTags(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、\s]+/)
      : []
  const out = []
  for (const item of raw) {
    const tag = String(item ?? '').trim()
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out.slice(0, 8)
}

/** 关联页：path 形式，最多 5 条；非法/重复的丢掉 */
export function normalizeLinks(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、\s]+/)
      : []
  const out = []
  for (const item of raw) {
    const link = String(item ?? '').trim().toLowerCase()
    if (!link || !/^[a-z0-9][a-z0-9/_-]{0,79}$/.test(link)) continue
    if (!out.includes(link)) out.push(link)
  }
  return out.slice(0, 5)
}

export function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!max || value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

/** 可见 = 没被忘、没被折叠进别的页 */
export function isVisible(page) {
  return Boolean(page) && !page.forgottenAt && !page.supersededBy
}

/**
 * 这条记忆记的是谁：'self'=我自己（人格记忆），'user'=对老大的观察（用户模型）。
 * 旧事件没有这个字段，一律按 self 处理。
 */
export function subjectOf(page) {
  return page?.subject === 'user' ? 'user' : 'self'
}

/**
 * 强度：分级权重 × 时间衰减 + 召回加成，封顶 1。
 * salience 1 或 pinned 恒为 1——"重要的永远在"。
 */
export function strengthOf(page, nowMs = Date.now(), options = {}) {
  if (!page) return 0
  if (page.pinned || page.salience === 1) return 1
  const cfg = { ...MEMORY, ...options }
  const base = cfg.salienceWeight?.[page.salience] ?? cfg.salienceWeight?.[2] ?? 0.6
  const anchor = Date.parse(page.lastRecallAt ?? page.updatedAt ?? page.at ?? '')
  const days = Number.isFinite(anchor) ? Math.max(0, (nowMs - anchor) / DAY_MS) : 0
  const recency = Math.pow(0.5, days / Math.max(1, cfg.halfLifeDays))
  const bonus = Math.min(cfg.recallBonusCap, Math.max(0, page.recallCount ?? 0) * cfg.recallBonus)
  return Math.min(1, Math.max(0, base * recency + bonus))
}

/** 粗略命中：标签/路径出现在这句话里就算；中文不切词，够用 */
export function matchScore(page, cue) {
  const text = String(cue ?? '').toLowerCase()
  if (!text || !page) return 0
  let score = 0
  const path = String(page.path ?? '').toLowerCase()
  if (path && text.includes(path)) score += 3
  for (const tag of page.tags ?? []) {
    const value = String(tag).toLowerCase()
    if (value.length >= 2 && text.includes(value)) score += 3
  }
  return score
}

function lineFor(page, cfg) {
  const head = `- [${page.path}] ${truncate(page.title || page.path, 18)}`
  const gist = truncate(page.gist || page.content, 40)
  const line = gist ? `${head}：${gist}` : head
  return line.length > cfg.lineMaxChars ? `${line.slice(0, cfg.lineMaxChars - 1)}…` : line
}

/**
 * 挑这一轮要注入的记忆目录。
 * 命中页的邻居也算「沾边」：分数减半补进来，但强度低于 hideBelow 的仍然不复活。
 * options.subject = 'self' | 'user' 时只挑这一边（人格记忆与用户模型分开注入）。
 * @returns {{text:string, selected:Array<{path:string, via:'fixed'|'strong'|'hit', linked?:boolean}>, lines:string[]}}
 */
export function memoryIndex(state, nowMs = Date.now(), cue = '', options = {}) {
  const cfg = { ...MEMORY, ...options }
  const subject = cfg.subject
  const fixed = []
  const rest = []
  for (const page of Object.values(state?.pages ?? {})) {
    if (!isVisible(page)) continue
    if (subject && subjectOf(page) !== subject) continue
    const strength = strengthOf(page, nowMs, cfg)
    if (page.pinned || page.salience === 1) fixed.push({ page, strength, hit: 0 })
    else rest.push({ page, strength, hit: matchScore(page, cue), linked: false })
  }

  const baseHits = rest.filter((item) => item.hit > 0 && item.strength >= cfg.hideBelow)
  const byPath = new Map(rest.map((item) => [item.page.path, item]))
  for (const item of baseHits) {
    for (const link of item.page.links ?? []) {
      const target = byPath.get(link)
      if (!target || target.hit > 0 || target.strength < cfg.hideBelow) continue
      target.hit = Math.max(1, Math.floor(item.hit / 2))
      target.linked = true
    }
  }

  const strong = rest
    .filter((item) => item.strength >= cfg.strongThreshold)
    .sort((a, b) => b.strength - a.strength)
  const hits = rest
    .filter((item) => item.strength < cfg.strongThreshold && item.hit > 0 && item.strength >= cfg.hideBelow)
    .sort((a, b) => b.hit - a.hit || b.strength - a.strength)

  const chosen = [...fixed, ...strong, ...hits].slice(0, cfg.indexMaxLines)
  const candidates = fixed.length + strong.length + hits.length
  if (!chosen.length) return { text: '', selected: [], lines: [], candidates }

  const header = cfg.header ?? '【记忆】你记得这些事（要细节就调 persona_recall）：'
  const budget = cfg.indexMaxChars - header.length - 1
  const lines = []
  const selected = []
  let used = 0
  for (const item of chosen) {
    const line = lineFor(item.page, cfg)
    if (used + line.length > budget) break
    lines.push(line)
    used += line.length + 1
    const entry = {
      path: item.page.path,
      via: item.page.pinned || item.page.salience === 1 ? 'fixed' : item.hit > 0 ? 'hit' : 'strong',
    }
    if (item.linked) entry.linked = true
    selected.push(entry)
  }
  if (!lines.length) return { text: '', selected: [], lines: [], candidates }
  return { text: `${header}\n${lines.join('\n')}`, selected, lines, candidates }
}

/**
 * 折叠候选：同 tag ≥3 条、够冷、够久没被召回、不是重要记忆。
 * 只给建议，压不压、怎么压由模型决定（persona_digest）。
 */
export function foldCandidates(state, nowMs = Date.now(), options = {}) {
  const cfg = { ...MEMORY, ...options }
  const groups = new Map()
  for (const page of Object.values(state?.pages ?? {})) {
    if (!isVisible(page)) continue
    if (page.kind === 'fold' || page.source === 'digest') continue
    if (page.salience === 1 || page.pinned) continue
    if (strengthOf(page, nowMs, cfg) >= cfg.foldBelowStrength) continue
    const anchor = Date.parse(page.lastRecallAt ?? page.updatedAt ?? page.at ?? '')
    if (!Number.isFinite(anchor)) continue
    if ((nowMs - anchor) / DAY_MS < cfg.foldAfterDays) continue
    const tag = normalizeTags(page.tags)[0]
    if (!tag) continue
    const list = groups.get(tag) ?? []
    list.push(page.path)
    groups.set(tag, list)
  }
  return [...groups.entries()]
    .filter(([, paths]) => paths.length >= cfg.foldMinGroup)
    .map(([tag, paths]) => ({ tag, paths }))
    .sort((a, b) => b.paths.length - a.paths.length)
}

/** 按关键词搜（空格分隔，全部命中才要），标签/路径精确命中加权；命中页的邻居补半档 */
export function searchPages(state, query, limit = 3, options = {}) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return []
  const hits = []
  for (const page of Object.values(state?.pages ?? {})) {
    if (!isVisible(page)) continue
    if (options.subject && subjectOf(page) !== options.subject) continue
    const hay = [page.path, page.title, page.gist, (page.tags ?? []).join(' '), page.content].join(' ').toLowerCase()
    let score = 0
    let all = true
    for (const term of terms) {
      if (!hay.includes(term)) {
        all = false
        break
      }
      score += Math.min(6, term.length)
    }
    if (!all) continue
    if ((page.tags ?? []).some((tag) => terms.includes(String(tag).toLowerCase()))) score += 6
    if (terms.some((term) => String(page.path).toLowerCase().includes(term))) score += 4
    score += strengthOf(page, Date.now(), options) * 2
    hits.push({ page, score })
  }
  hits.sort((a, b) => b.score - a.score)

  // 一跳：直接命中的页，它关联的页也拉进来，分数减半（只从最靠前的几条扩散）
  const seen = new Set(hits.map((hit) => hit.page.path))
  const linked = []
  for (const hit of hits.slice(0, 3)) {
    for (const path of hit.page.links ?? []) {
      if (seen.has(path)) continue
      const page = state?.pages?.[path]
      if (!isVisible(page)) continue
      seen.add(path)
      linked.push({ page, score: hit.score * 0.5 })
    }
  }

  return [...hits, ...linked]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.page)
}

export function memoryStats(state, subject) {
  const all = Object.values(state?.pages ?? {})
  const pages = subject ? all.filter((page) => subjectOf(page) === subject) : all
  const visible = pages.filter(isVisible)
  const outgoing = visible.filter((page) => (page.links ?? []).length > 0)
  const incoming = new Set()
  for (const page of visible) {
    for (const link of page.links ?? []) incoming.add(link)
  }
  return {
    total: pages.length,
    visible: visible.length,
    folded: pages.filter((page) => page.kind === 'fold').length,
    superseded: pages.filter((page) => page.supersededBy).length,
    forgotten: pages.filter((page) => page.forgottenAt).length,
    linked: outgoing.length,
    isolated: visible.filter((page) => !(page.links ?? []).length && !incoming.has(page.path)).length,
  }
}
