import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvent } from '../src/journal.js'
import { fold } from '../src/replay.js'
import { buildGraph } from '../src/graph.js'

const at = (iso) => new Date(iso)
const NOW = at('2026-11-01T12:00:00+08:00')

const page = (path, overrides = {}) => ({
  path,
  title: `页 ${path}`,
  content: `${path} 的正文`,
  gist: '',
  tags: [],
  salience: 2,
  ...overrides,
})

function stateOf(events) {
  return fold(events).state
}

test('graph: 空状态给空图，计数归零', () => {
  const graph = buildGraph(stateOf([]), NOW)
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])
  assert.deepEqual(graph.stats, { pages: 0, shown: 0, links: 0, isolated: 0 })
})

test('graph: 节点按强度降序，超过上限只留最强的', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('a/strong', { salience: 1 }), at('2026-10-30T10:00:00+08:00')),
    makeEvent('page', 'dev', page('b/weak', { salience: 3 }), at('2025-01-01T10:00:00+08:00')),
    makeEvent('page', 'dev', page('c/mid'), at('2026-09-01T10:00:00+08:00')),
  ])
  const graph = buildGraph(state, NOW, { maxNodes: 2 })
  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0].id, 'a/strong')
  assert.equal(graph.stats.pages, 3)
  assert.equal(graph.stats.shown, 2)
})

test('graph: 边来自 links，去掉重复与指向图外的链接', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('a', { links: ['b', 'ghost'] }), at('2026-10-30T10:00:00+08:00')),
    makeEvent('page', 'dev', page('b', { links: ['a', 'c'] }), at('2026-10-30T10:00:00+08:00')),
    makeEvent('page', 'dev', page('c'), at('2026-10-30T10:00:00+08:00')),
  ])
  const graph = buildGraph(state, NOW)
  assert.equal(graph.edges.length, 2)
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.source}>${edge.target}`).sort(),
    ['a>b', 'b>c'],
  )
  const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))
  assert.equal(byId.a.degree, 1)
  assert.equal(byId.b.degree, 2)
  assert.equal(graph.stats.isolated, 0)
})

test('graph: 带上下文字段，孤立页单独计数', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('self/a', { subject: 'self', gist: '认识老大', tags: ['老大'] }), at('2026-10-30T10:00:00+08:00')),
    makeEvent('page', 'dev', page('user/a', { subject: 'user', title: '作息' }), at('2026-10-30T10:00:00+08:00')),
  ])
  const graph = buildGraph(state, NOW)
  const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))
  assert.equal(byId['self/a'].subject, 'self')
  assert.equal(byId['user/a'].subject, 'user')
  assert.equal(byId['self/a'].gist, '认识老大')
  assert.deepEqual(byId['self/a'].tags, ['老大'])
  assert.equal(graph.stats.isolated, 2)
})

test('graph: 已遗忘的页不进图', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('a'), at('2026-10-30T10:00:00+08:00')),
    makeEvent('forget', 'dev', { path: 'a', why: '不再需要' }, at('2026-10-30T11:00:00+08:00')),
  ])
  const graph = buildGraph(state, NOW)
  assert.equal(graph.nodes.length, 0)
  assert.equal(graph.stats.pages, 0)
})
