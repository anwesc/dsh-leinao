/**
 * 对话索引：把全量消息存进 journal 之后，用中文二元组做倒排索引。
 *
 * 为什么不用向量：插件拿不到 embedding 接口（只有 systemPrompt / tools / agents），
 * 本地跑模型又太重。二元组字面匹配在同义词上会漏，但零依赖、可重建、够快，
 * 先把「召回范围从整理过的页扩到所有对话」这一步走通。
 *
 * 索引不落盘：每次从 journal 里的 message 事件重建，缓存放在内存，
 * 靠 journal 指纹判断要不要重建；换机器、git pull 之后也能自己长出来。
 */

export const INDEXER = {
  maxDocs: 3000,
  maxTextChars: 2000,
  maxLines: 2,
  minScore: 0.35,
  snippetChars: 100,
}

const STOP_SINGLE = new Set('的了是在我你他她它也就都而不吗呢啊吧有和与或这那个上下来去说要会能可以很太更最没'.split(''))

const CJK = /[\u3400-\u9fff]/

/**
 * 中文按二元组切，英文/数字按词切；单字停用词丢掉。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase()
  const tokens = []
  // 英文与数字
  for (const word of value.match(/[a-z0-9_]{2,}/g) ?? []) tokens.push(word)
  // 中文连续段按二元组切
  for (const run of value.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP_SINGLE.has(run)) tokens.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const pair = run.slice(i, i + 2)
      if (STOP_SINGLE.has(pair[0]) && STOP_SINGLE.has(pair[1])) continue
      tokens.push(pair)
    }
  }
  return tokens
}

/**
 * @param {Array<{id?:string, role?:string, text?:string, at?:string}>} messages
 * @param {{maxDocs?:number}} [options]
 */
export function buildIndex(messages = [], options = {}) {
  const maxDocs = Math.max(1, Number(options.maxDocs ?? INDEXER.maxDocs))
  const docs = []
  for (const message of messages) {
    const text = String(message?.text ?? '').trim()
    if (!text) continue
    docs.push({
      id: String(message.id ?? docs.length),
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: text.slice(0, INDEXER.maxTextChars),
      at: message.at ?? null,
      tokens: tokenize(text),
    })
  }
  const recent = docs.slice(-maxDocs)
  const df = new Map()
  for (const doc of recent) {
    for (const token of new Set(doc.tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }
  return { docs: recent, df, total: recent.length, avgLen: average(recent) }
}

function average(docs) {
  if (!docs.length) return 1
  const sum = docs.reduce((acc, doc) => acc + doc.tokens.length, 0)
  return Math.max(1, sum / docs.length)
}

/**
 * BM25 打分；只返回分数过线的文档。
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{limit?:number, minScore?:number}} [options]
 */
export function searchIndex(index, query, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 5))
  const minScore = Number(options.minScore ?? 0)
  const queryTokens = [...new Set(tokenize(query))]
  if (!index?.total || !queryTokens.length) return []

  const k1 = 1.2
  const b = 0.75
  const scored = []
  for (const doc of index.docs) {
    if (!doc.tokens.length) continue
    const tf = new Map()
    for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) {
      const freq = tf.get(token)
      if (!freq) continue
      const df = index.df.get(token) ?? 0
      const idf = Math.log(1 + (index.total - df + 0.5) / (df + 0.5))
      const norm = freq + k1 * (1 - b + (b * doc.tokens.length) / index.avgLen)
      score += (idf * (freq * (k1 + 1))) / norm
    }
    if (score >= minScore && score > 0) scored.push({ ...doc, score })
  }
  scored.sort((a, b2) => b2.score - a.score || String(b2.at).localeCompare(String(a.at)))
  return scored.slice(0, limit)
}

/** 从命中处截一小段，避免把整条消息塞进注入 */
export function snippet(text, query, maxChars = INDEXER.snippetChars) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxChars) return value
  const tokens = tokenize(query).filter((token) => token.length >= 2)
  let at = -1
  for (const token of tokens) {
    at = value.toLowerCase().indexOf(token)
    if (at >= 0) break
  }
  if (at < 0) return `${value.slice(0, maxChars - 1)}…`
  const start = Math.max(0, at - Math.floor(maxChars / 3))
  const end = Math.min(value.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

/**
 * 混合召回：BM25 与向量各排各的，再用 RRF（ Reciprocal Rank Fusion，按名次给分）合并。
 * 纯向量对专有名词不敏感，纯字面又漏同义词，两路互补。
 */
export function fuseHits(index, bmHits = [], vectorHits = [], limit = INDEXER.maxLines) {
  const docs = new Map((index?.docs ?? []).map((doc) => [String(doc.id), doc]))
  const scores = new Map()
  const add = (id, rank) => {
    const key = String(id)
    if (!docs.has(key)) return
    scores.set(key, (scores.get(key) ?? 0) + 1 / (60 + rank + 1))
  }
  bmHits.forEach((hit, rank) => add(hit.id, rank))
  vectorHits.forEach((hit, rank) => add(hit.id, rank))
  return [...scores.entries()]
    .map(([id, score]) => ({ ...docs.get(id), score }))
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)))
    .slice(0, limit)
}

/**
 * 注入用的一段「相关对话」，没有命中返回 ''。
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} cue
 * @param {object} [config]
 * @param {{vectorHits?:Array}} [extra]
 */
export function recallLines(index, cue, config = {}, extra = {}) {
  if (config.recallEnabled === false) return ''
  const limit = Math.max(0, Number(config.recallMaxLines ?? INDEXER.maxLines))
  if (!limit) return ''
  const bmHits = searchIndex(index, cue, { limit: Math.max(limit * 3, 8), minScore: INDEXER.minScore })
  const vectorHits = Array.isArray(extra.vectorHits) ? extra.vectorHits : []
  const hits = vectorHits.length ? fuseHits(index, bmHits, vectorHits, limit) : bmHits.slice(0, limit)
  if (!hits.length) return ''
  const lines = hits.map((hit) => `- ${hit.role === 'user' ? '你' : '我'}：${snippet(hit.text, cue)}`)
  return `【相关】你这句话，以前的对话里提过：\n${lines.join('\n')}`
}
