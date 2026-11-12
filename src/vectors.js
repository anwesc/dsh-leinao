/**
 * 向量的旁路存储：journal 里是原文，这里只存 `{messageId, hash, vec}`。
 *
 * 为什么不进 state.json：向量又大又可以从原文重算，属于缓存，不是真源。
 * 为什么不是向量库：3000 条 × 768 维暴力算余弦是毫秒级，引入 ANN 只是多一个依赖。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from './store.js'

export const VECTORS = {
  version: 1,
  maxItems: 3000,
  queryLimit: 8,
}

export function vectorPath(dataDir) {
  return join(dataDir, 'index', 'vectors.json')
}

export function textHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16)
}

/** 读旁路文件；模型/地址换了就当没有，避免拿旧模型的向量算余弦 */
export function loadVectors(dataDir, embedderId) {
  try {
    const data = JSON.parse(readFileSync(vectorPath(dataDir), 'utf8'))
    if (data?.version !== VECTORS.version || data.embedderId !== embedderId) {
      return { embedderId, dims: Number(data?.dims) || 0, items: [] }
    }
    return {
      embedderId,
      dims: Number(data.dims) || 0,
      items: Array.isArray(data.items) ? data.items : [],
    }
  } catch {
    return { embedderId, dims: 0, items: [] }
  }
}

export function saveVectors(dataDir, store) {
  const file = vectorPath(dataDir)
  mkdirSync(dirname(file), { recursive: true })
  writeFileAtomic(
    file,
    `${JSON.stringify({ version: VECTORS.version, embedderId: store.embedderId, dims: store.dims, items: store.items })}\n`,
  )
  return file
}

/**
 * 只给新增/变化的 message 算向量；没变的不重复花钱。
 * @param {{dataDir:string, messages:Array, embedder:object, store?:object, maxItems?:number}} input
 */
export async function syncVectors(input) {
  const { dataDir, messages, embedder } = input
  const maxItems = input.maxItems ?? VECTORS.maxItems
  const base = input.store && input.store.embedderId === embedder.id ? input.store : loadVectors(dataDir, embedder.id)
  const byId = new Map((base.items ?? []).map((item) => [item.id, item]))
  const pending = []
  for (const message of messages ?? []) {
    const text = String(message?.text ?? '').trim()
    if (!text) continue
    const id = String(message.id ?? '')
    if (!id) continue
    const hash = textHash(text)
    const hit = byId.get(id)
    if (hit && hit.hash === hash) continue
    pending.push({ id, at: message.at ?? null, hash, text })
  }

  let changed = false
  if (pending.length) {
    const vectors = await embedder.embed(pending.map((item) => item.text))
    pending.forEach((item, index) => {
      const vec = vectors[index]
      if (!vec?.length) return
      byId.set(item.id, { id: item.id, at: item.at, hash: item.hash, vec })
      changed = true
    })
  }

  const items = [...byId.values()]
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
    .slice(-maxItems)
  const next = { embedderId: embedder.id, dims: embedder.dims || base.dims || 0, items }
  if (changed || items.length !== (base.items ?? []).length || next.dims !== base.dims) {
    saveVectors(dataDir, next)
  }
  return next
}

export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

export function searchVectors(store, queryVec, limit = VECTORS.queryLimit) {
  if (!store?.items?.length || !queryVec?.length) return []
  const scored = []
  for (const item of store.items) {
    if (!item.vec?.length || item.vec.length !== queryVec.length) continue
    scored.push({ id: item.id, at: item.at, score: cosine(queryVec, item.vec) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
