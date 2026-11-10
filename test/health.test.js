import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvent } from '../src/journal.js'
import { fold } from '../src/replay.js'
import { buildHealth } from '../src/health.js'

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

const stateOf = (events) => fold(events).state

test('health: 空记忆给满分，但不假装有东西', () => {
  const health = buildHealth(stateOf([]), NOW)
  assert.equal(health.score, 100)
  assert.equal(health.grade, '还没开始')
  assert.equal(health.checks.length, 1)
  assert.deepEqual(health.stale, [])
  assert.equal(health.size.pages, 0)
})

test('health: 新鲜、互链、索引没满时是健康', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('a', { links: ['b'] }), at('2026-10-30T10:00:00+08:00')),
    makeEvent('page', 'dev', page('b', { links: ['a'] }), at('2026-10-31T10:00:00+08:00')),
  ])
  const health = buildHealth(state, NOW)
  assert.equal(health.score, 100)
  assert.equal(health.grade, '健康')
  assert.ok(health.checks.every((check) => check.ok))
  assert.equal(health.freshness.today + health.freshness.week + health.freshness.month, 2)
})

test('health: 索引塞满、全是孤点、都是旧页时分数掉下来', () => {
  const events = []
  for (const path of ['a', 'b', 'c']) {
    events.push(makeEvent('page', 'dev', page(path, { salience: 1 }), at('2025-01-01T10:00:00+08:00')))
  }
  for (let index = 0; index < 3; index += 1) {
    events.push(makeEvent('observation', 'dev', {
      key: `习惯${index}`,
      value: '说不准',
      evidence: '大概吧',
      confidence: 0.3,
    }, at('2025-01-01T10:00:00+08:00')))
  }
  const health = buildHealth(stateOf(events), NOW)
  const failed = health.checks.filter((check) => !check.ok).map((check) => check.id)
  assert.deepEqual(failed.sort(), ['fresh', 'index', 'links', 'observations'])
  assert.ok(health.score < 60)
  assert.equal(health.grade, '该整理了')
  assert.equal(health.stale.length, 0, 'salience 1 不衰减，不算该重读')
})

test('health: 旧但很弱的页才进「可以重读」，强页不进', () => {
  const state = stateOf([
    makeEvent('page', 'dev', page('old/weak', { salience: 3 }), at('2025-01-01T10:00:00+08:00')),
    makeEvent('page', 'dev', page('new/strong', { salience: 1 }), at('2026-10-30T10:00:00+08:00')),
  ])
  const health = buildHealth(state, NOW)
  assert.deepEqual(health.stale.map((item) => item.path), ['old/weak'])
  assert.equal(health.size.pages, 2)
  assert.ok(health.size.chars > 0)
})
