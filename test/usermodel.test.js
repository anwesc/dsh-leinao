import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEvent, emptyState } from '../src/replay.js'
import { buildUserModel } from '../src/userModel.js'

const at = '2026-11-01T10:00:00.000Z'

function seed(events) {
  const state = emptyState()
  for (const event of events) applyEvent(state, event)
  return state
}

test('observation-drop 删掉一条观察，observation-clear 清空', () => {
  const state = seed([
    { kind: 'observation', at, key: '作息', value: '常熬夜', evidence: '又两点睡', confidence: 0.8 },
    { kind: 'observation', at, key: '口味', value: '偏辣', evidence: '多点辣', confidence: 0.6 },
  ])
  assert.equal(Object.keys(state.observations).length, 2)

  applyEvent(state, { kind: 'observation-drop', at, key: '作息' })
  assert.deepEqual(Object.keys(state.observations), ['口味'])

  applyEvent(state, { kind: 'observation-drop', at, key: '不存在' })
  assert.deepEqual(Object.keys(state.observations), ['口味'], '删不存在的 key 不该改动别的')

  applyEvent(state, { kind: 'observation-clear', at })
  assert.deepEqual(Object.keys(state.observations), [])
})

test('buildUserModel 只收可见的 user 页，按更新时间倒序', () => {
  const state = seed([
    { kind: 'seed', at, profile: { name: '大肥鱼' } },
    { kind: 'page', at, path: 'people/me', title: '我', content: 'a', subject: 'self' },
    { kind: 'page', at, path: 'people/laoda', title: '老大', content: 'b', subject: 'user', gist: '程序员' },
    { kind: 'page', at: '2026-11-02T10:00:00.000Z', path: 'people/laoda/hobby', title: '爱好', content: 'c', subject: 'user' },
    { kind: 'page', at, path: 'people/old', title: '旧', content: 'd', subject: 'user' },
    { kind: 'forget', at, path: 'people/old' },
    { kind: 'observation', at, key: '作息', value: '常熬夜', evidence: '又两点睡', confidence: 0.8 },
    { kind: 'observation', at, key: '口味', value: '偏辣', evidence: '多点辣', confidence: 0.4 },
  ])

  const model = buildUserModel(state)
  assert.deepEqual(model.pages.map((page) => page.path), ['people/laoda/hobby', 'people/laoda'])
  assert.equal(model.counts.pages, 2)
  assert.equal(model.counts.observations, 2)
  assert.equal(model.counts.confident, 1, '置信度低于 0.5 的不算「较确定」')
  assert.equal(model.observations[0].key, '作息', '置信度高的排前面')
  assert.equal(model.observations[0].evidence, '又两点睡')
})
