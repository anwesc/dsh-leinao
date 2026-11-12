/**
 * Embedding 适配器：默认关闭，开了才把对话发出去。
 *
 * 不引 SDK：兼容 OpenAI 的 `POST {baseUrl}/embeddings`（SiliconFlow 的 bge-m3、
 * Ollama 的 /v1/embeddings 都是这个形状），只依赖全局 fetch。
 * 失败一律抛出，由调用方退回字面检索——检索可以少，但一轮对话不能因此失败。
 */

export const EMBEDDING = {
  timeoutMs: 8000,
  batchSize: 32,
  maxTextChars: 2000,
}

/**
 * @param {object} raw `memory.embedding` 配置
 * @param {NodeJS.ProcessEnv} [env]
 */
export function normalizeEmbeddingConfig(raw = {}, env = process.env) {
  const baseUrl = String(raw?.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = String(raw?.model ?? '').trim()
  const dims = Number(raw?.dims) > 0 ? Math.floor(Number(raw.dims)) : 0
  const apiKey = String(raw?.apiKey ?? env.DSH_LEINAO_EMBED_KEY ?? '').trim()
  const timeoutMs = Math.max(500, Number(raw?.timeoutMs) || EMBEDDING.timeoutMs)
  return {
    enabled: raw?.enabled === true && Boolean(baseUrl) && Boolean(model),
    baseUrl,
    model,
    dims,
    apiKey,
    timeoutMs,
  }
}

/**
 * @param {object} raw
 * @param {{fetchImpl?:Function}} [options]
 * @returns {null | {id:string, dims:number, embed:(texts:string[])=>Promise<number[][]>}}
 */
export function createEmbedder(raw, options = {}) {
  const config = normalizeEmbeddingConfig(raw)
  if (!config.enabled) return null
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return null

  const url = /\/embeddings$/.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/embeddings`
  let dims = config.dims

  async function embed(texts) {
    const input = (texts ?? [])
      .map((text) => String(text ?? '').trim().slice(0, EMBEDDING.maxTextChars))
      .filter(Boolean)
    if (!input.length) return []
    const out = []
    for (let i = 0; i < input.length; i += EMBEDDING.batchSize) {
      const batch = input.slice(i, i + EMBEDDING.batchSize)
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input: batch }),
        signal: AbortSignal.timeout(config.timeoutMs),
      })
      if (!response.ok) throw new Error(`embedding HTTP ${response.status}`)
      const body = await response.json()
      const rows = Array.isArray(body?.data) ? body.data : []
      if (rows.length !== batch.length) throw new Error('embedding 返回条数不对')
      for (const row of rows) {
        const vec = Array.isArray(row?.embedding) ? row.embedding.map(Number) : null
        if (!vec?.length) throw new Error('embedding 返回空向量')
        if (!dims) dims = vec.length
        if (vec.length !== dims) throw new Error('embedding 维度不一致')
        out.push(vec)
      }
    }
    return out
  }

  return {
    id: `${url}|${config.model}`,
    get dims() {
      return dims
    },
    embed,
  }
}
