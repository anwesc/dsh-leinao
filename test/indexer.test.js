import test from 'node:test'
import assert from 'node:assert/strict'

import { INDEXER, buildIndex, fuseHits, recallLines, searchIndex, snippet, tokenize } from '../src/indexer.js'

const docs = [
  { id: 'a', role: 'user', text: '以后周末别排活，我想休息', at: '2026-11-01T10:00:00.000Z' },
  { id: 'b', role: 'assistant', text: '记忆图谱的三栏布局已经改好了，设置页左边是目录', at: '2026-11-02T10:00:00.000Z' },
  { id: 'c', role: 'user', text: '今天天气不错，出去走走', at: '2026-11-03T10:00:00.000Z' },
]

test('indexer: 中文按二元组切，英文按词切，停用单字丢掉', () => {
  const tokens = tokenize('记忆图谱 Memory Graph v2 的 了')
  assert.ok(tokens.includes('记忆'))
  assert.ok(tokens.includes('图谱'))
  assert.ok(tokens.includes('memory'))
  assert.ok(tokens.includes('graph'))
  assert.ok(tokens.includes('v2'))
  assert.ok(!tokens.includes('的'))
  assert.deepEqual(tokenize(''), [])
})

test('indexer: 命中排在前面，且只返回过线的结果', () => {
  const index = buildIndex(docs)
  const hits = searchIndex(index, '记忆图谱三栏布局', { limit: 2 })
  assert.equal(hits[0].id, 'b')
  assert.ok(hits[0].score > 0)
  assert.deepEqual(searchIndex(index, '完全无关的词'), [])
})

test('indexer: 空索引和空查询不炸', () => {
  assert.deepEqual(searchIndex(buildIndex([]), '记忆'), [])
  assert.deepEqual(searchIndex(buildIndex(docs), ''), [])
  assert.equal(recallLines(buildIndex([]), '记忆'), '')
})

test('indexer: 召回带角色前缀，可整体关掉，条数受 maxLines 限制', () => {
  const index = buildIndex(docs)
  const text = recallLines(index, '记忆图谱三栏布局', { recallMaxLines: 2 })
  assert.match(text, /【相关】/)
  assert.match(text, /- (你|我)：/)
  assert.match(text, /三栏布局/)
  assert.equal(recallLines(index, '记忆图谱三栏布局', { recallEnabled: false }), '')
  assert.equal(recallLines(index, '记忆图谱三栏布局', { recallMaxLines: 0 }), '')
  const one = recallLines(index, '记忆图谱三栏布局', { recallMaxLines: 1 })
  assert.equal(one.split('\n').length, 2)
})

test('indexer: 片段从命中处截，避免整条消息进注入', () => {
  const long = `${'开场白'.repeat(20)}记忆图谱三栏布局${'结尾'.repeat(20)}`
  const cut = snippet(long, '三栏布局', 40)
  assert.ok(cut.length <= 42, `length=${cut.length}`)
  assert.ok(cut.includes('三栏布局'))
  assert.ok(cut.startsWith('…') || cut.endsWith('…'))
  assert.ok(INDEXER.minScore > 0 && INDEXER.maxDocs > 0)
})

test('indexer: 向量命中能和字面结果融合，轮到同义词场景', () => {
  const index = buildIndex(docs)
  // 「啰嗦」字面对不上「太长」；这里用向量命中模拟语义召回
  const vectorHits = [{ id: 'a', at: '2026-11-01T10:00:00.000Z', score: 0.82 }]
  const text = recallLines(index, '回复太啰嗦了', { recallMaxLines: 2 }, { vectorHits })
  assert.match(text, /【相关】/)
  assert.match(text, /周末别排活/)

  const fused = fuseHits(index, [], vectorHits, 2)
  assert.equal(fused[0].id, 'a')
  assert.ok(fused[0].score > 0)
  // 不存在的文档 id 不参与融合
  assert.deepEqual(fuseHits(index, [], [{ id: 'zzz', score: 1 }], 2), [])
})
