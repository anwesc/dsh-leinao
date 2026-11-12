import test from 'node:test'
import assert from 'node:assert/strict'

import { EMBEDDING, createEmbedder, normalizeEmbeddingConfig } from '../src/embed.js'

function fakeFetch(onRequest) {
  const calls = []
  const impl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, init, body })
    const payload = onRequest ? onRequest(body, calls.length) : { data: body.input.map((text, i) => ({ embedding: [text.length, i + 1, 0.5] })) }
    return { ok: payload.ok !== false, status: payload.status ?? 200, json: async () => payload.body ?? payload }
  }
  return { impl, calls }
}

test('embed: 没配地址或模型就不启用', () => {
  assert.equal(createEmbedder({ enabled: true, baseUrl: '', model: 'bge' }), null)
  assert.equal(createEmbedder({ enabled: true, baseUrl: 'https://x/v1', model: '' }), null)
  assert.equal(createEmbedder({ enabled: false, baseUrl: 'https://x/v1', model: 'bge' }), null)
  assert.equal(normalizeEmbeddingConfig({ enabled: true, baseUrl: 'https://x/v1/', model: 'bge' }).baseUrl, 'https://x/v1')
})

test('embed: 走 OpenAI 兼容的 /embeddings，带上模型和密钥', async () => {
  const { impl, calls } = fakeFetch()
  const embedder = createEmbedder(
    { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'BAAI/bge-m3', apiKey: 'k-1' },
    { fetchImpl: impl },
  )
  const [vec] = await embedder.embed(['记忆图谱'])
  assert.deepEqual(vec, [4, 1, 0.5])
  assert.equal(calls[0].url, 'https://api.example.com/v1/embeddings')
  assert.equal(calls[0].init.headers.authorization, 'Bearer k-1')
  assert.equal(calls[0].body.model, 'BAAI/bge-m3')
  assert.deepEqual(calls[0].body.input, ['记忆图谱'])
  assert.equal(embedder.id, 'https://api.example.com/v1/embeddings|BAAI/bge-m3')
  assert.equal(embedder.dims, 3)
})

test('embed: 地址已经带 /embeddings 就不重复拼', async () => {
  const { impl, calls } = fakeFetch()
  const embedder = createEmbedder({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1/embeddings', model: 'nomic' }, { fetchImpl: impl })
  await embedder.embed(['x'])
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings')
})

test('embed: 超过一批就分批发，空文本跳过', async () => {
  const { impl, calls } = fakeFetch()
  const embedder = createEmbedder({ enabled: true, baseUrl: 'https://x/v1', model: 'm' }, { fetchImpl: impl })
  const texts = Array.from({ length: EMBEDDING.batchSize + 3 }, (_, i) => `第 ${i} 条`)
  const vecs = await embedder.embed(texts)
  assert.equal(vecs.length, texts.length)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.input.length, EMBEDDING.batchSize)
  assert.equal(calls[1].body.input.length, 3)
  assert.deepEqual(await embedder.embed(['', '  ']), [])
})

test('embed: HTTP 失败、条数不对、维度不一致都抛出', async () => {
  const embedder = createEmbedder(
    { enabled: true, baseUrl: 'https://x/v1', model: 'm' },
    { fetchImpl: fakeFetch(() => ({ ok: false, status: 401 })).impl },
  )
  await assert.rejects(() => embedder.embed(['a']), /401/)

  const short = createEmbedder(
    { enabled: true, baseUrl: 'https://x/v1', model: 'm' },
    { fetchImpl: fakeFetch(() => ({ data: [] })).impl },
  )
  await assert.rejects(() => short.embed(['a']), /条数/)

  const bad = createEmbedder(
    { enabled: true, baseUrl: 'https://x/v1', model: 'm' },
    { fetchImpl: fakeFetch(() => ({ data: [{ embedding: [] }] })).impl },
  )
  await assert.rejects(() => bad.embed(['a']), /空向量/)

  let n = 0
  const mixed = createEmbedder(
    { enabled: true, baseUrl: 'https://x/v1', model: 'm' },
    { fetchImpl: fakeFetch(() => ({ data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2] }] })).impl },
  )
  await assert.rejects(() => mixed.embed(['a', 'b']), /维度/)
})
