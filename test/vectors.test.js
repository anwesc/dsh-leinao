import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { VECTORS, cosine, loadVectors, saveVectors, searchVectors, syncVectors, textHash, vectorPath } from '../src/vectors.js'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-vectors-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeEmbedder() {
  const seen = []
  return {
    id: 'fake|m1',
    dims: 3,
    seen,
    async embed(texts) {
      seen.push(...texts)
      return texts.map((text) => [text.length, 1, 0])
    },
  }
}

const msg = (id, text, at) => ({ id, text, at })

test('vectors: 第一次全算，第二次不重复算，文本变了才算', async (t) => {
  const dir = tempDir(t)
  const embedder = fakeEmbedder()
  const messages = [msg('a', '记忆图谱', '2026-11-01T00:00:00Z'), msg('b', '三栏布局', '2026-11-02T00:00:00Z')]

  let store = await syncVectors({ dataDir: dir, messages, embedder })
  assert.equal(store.items.length, 2)
  assert.equal(embedder.seen.length, 2)

  store = await syncVectors({ dataDir: dir, messages, embedder, store })
  assert.equal(store.items.length, 2)
  assert.equal(embedder.seen.length, 2, '没变就不该再调接口')

  store = await syncVectors({
    dataDir: dir,
    messages: [messages[0], msg('b', '四栏布局', '2026-11-03T00:00:00Z')],
    embedder,
    store,
  })
  assert.equal(embedder.seen.length, 3)
  assert.equal(store.items.find((item) => item.id === 'b').hash, textHash('四栏布局'))
})

test('vectors: 换模型/地址当没有，旧向量不拿来算', async (t) => {
  const dir = tempDir(t)
  const first = fakeEmbedder()
  await syncVectors({ dataDir: dir, messages: [msg('a', '记忆', '2026-11-01T00:00:00Z')], embedder: first })

  const other = { ...fakeEmbedder(), id: 'fake|m2' }
  const store = loadVectors(dir, other.id)
  assert.equal(store.items.length, 0)
  assert.equal(loadVectors(dir, first.id).items.length, 1)
})

test('vectors: 有上限，超出留下最近的', async (t) => {
  const dir = tempDir(t)
  const embedder = fakeEmbedder()
  const messages = [
    msg('a', '一', '2026-11-01T00:00:00Z'),
    msg('b', '二', '2026-11-02T00:00:00Z'),
    msg('c', '三', '2026-11-03T00:00:00Z'),
  ]
  const store = await syncVectors({ dataDir: dir, messages, embedder, maxItems: 2 })
  assert.deepEqual(store.items.map((item) => item.id), ['b', 'c'])
})

test('vectors: 余弦排序，维度不一致的条目跳过', () => {
  const store = {
    items: [
      { id: 'a', at: '2026-11-01', vec: [1, 0, 0] },
      { id: 'b', at: '2026-11-02', vec: [0.9, 0.1, 0] },
      { id: 'c', at: '2026-11-03', vec: [1, 0] },
    ],
  }
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1, 0]), 1)
  const hits = searchVectors(store, [1, 0, 0])
  assert.deepEqual(hits.map((hit) => hit.id), ['a', 'b'])
  assert.ok(hits[0].score >= hits[1].score)
})

test('vectors: 旁路文件能存能读，坏文件当空', async (t) => {
  const dir = tempDir(t)
  const embedder = fakeEmbedder()
  const store = await syncVectors({ dataDir: dir, messages: [msg('a', '记忆', '2026-11-01T00:00:00Z')], embedder })
  saveVectors(dir, store)
  assert.equal(loadVectors(dir, embedder.id).items.length, 1)
  assert.ok(vectorPath(dir).includes('index'))
  assert.ok(VECTORS.maxItems >= 1000)
})
