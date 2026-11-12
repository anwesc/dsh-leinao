import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, makeEvent, scanEvents } from '../src/journal.js'
import { applyEvent, emptyState, fold, intimacyOf } from '../src/replay.js'
import { loadState, personaPaths, saveState, writeJsonAtomic } from '../src/store.js'
import { renderProfile, writeProfile } from '../src/render.js'
import { buildInjection, seedInjection } from '../src/prompt.js'
import { band } from '../src/mood.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-state-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const at = (iso) => new Date(iso)

test('replay: 空状态=出生前，seed 之后才 active', () => {
  const empty = emptyState()
  assert.equal(empty.phase, 'seed')
  assert.equal(empty.profile.name, null)

  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '阿鱼', gender: '女', userCall: '老大' }, at('2026-11-01T10:00:00+08:00')),
  ])
  assert.equal(state.phase, 'active')
  assert.equal(state.profile.name, '阿鱼')
  assert.equal(state.profile.userCall, '老大')
})

test('replay: affect 推心情、只数用户轮次；非法事件被跳过', () => {
  const events = [
    makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00')),
    makeEvent('affect', 'dev-a', { signal: { v: -1, e: 0, t: 0.5 }, role: 'user' }, at('2026-11-01T10:05:00+08:00')),
    makeEvent('affect', 'dev-a', { signal: { v: 0, e: 0, t: 0 }, role: 'assistant' }, at('2026-11-01T10:06:00+08:00')),
    makeEvent('affect', 'dev-a', { signal: { v: 'x' } }, at('2026-11-01T10:07:00+08:00')),
    { id: 'bad-1', at: 'not-a-date', kind: 'affect' },
  ]
  const { state, diagnostics } = fold(events)
  assert.equal(diagnostics.applied, 3)
  assert.equal(diagnostics.skipped, 2)
  assert.equal(state.stats.userTurns, 1)
  assert.ok(state.mood.v < 0.5, `mood.v=${state.mood.v}`)
})

test('replay: 成长有阻力，跨刻度写里程碑', () => {
  const events = [makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00'))]
  for (let i = 0; i < 12; i += 1) {
    const hour = String(i + 1).padStart(2, '0')
    events.push(makeEvent('growth', 'dev-a', { axis: 'warmth', delta: 0.03, evidence: [{ sessionId: 's', seq: i }] }, at(`2026-11-02T${hour}:00:00+08:00`)))
  }
  const { state } = fold(events)
  assert.ok(state.traits.warmth.v > 0.65, `warmth=${state.traits.warmth.v}`)
  assert.ok(state.traits.warmth.v < 0.5 + 12 * 0.03, '应当小于线性累加（有阻力）')
  assert.ok(state.milestones.some((m) => m.step === 0.6))
  assert.ok(state.milestones.some((m) => m.step === 0.7))
})

test('replay: reset all 回到出生前', () => {
  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00')),
    makeEvent('growth', 'dev-a', { axis: 'rigor', delta: 0.03 }, at('2026-11-02T10:00:00+08:00')),
    makeEvent('reset', 'dev-a', { scope: 'all' }, at('2026-11-03T10:00:00+08:00')),
  ])
  assert.equal(state.phase, 'seed')
  assert.equal(state.profile.name, null)
  assert.equal(state.traits.rigor.v, 0.5)
})

test('replay: 亲密度随轮次上升但有上限', () => {
  const state = emptyState()
  state.stats.userTurns = 0
  assert.ok(intimacyOf(state) <= 0.16)
  state.stats.userTurns = 500
  state.stats.seededAt = '2026-01-01T00:00:00+08:00'
  state.stats.lastEventAt = '2026-06-01T00:00:00+08:00'
  assert.ok(intimacyOf(state) <= 0.9)
  assert.ok(intimacyOf(state) > 0.7)
})

test('store: 先重放、再命中缓存、journal 变了就重建', () => {
  const { dir, cleanup } = tmp()
  try {
    appendEvent(dir, 'dev-a', makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00')))
    const first = loadState(dir)
    assert.equal(first.rebuilt, true)
    saveState(dir, first.state, first.scan)

    const second = loadState(dir)
    assert.equal(second.cached, true)
    assert.equal(second.state.profile.name, '阿鱼')

    appendEvent(dir, 'dev-a', makeEvent('affect', 'dev-a', { signal: { v: 1, e: 0, t: 0 }, role: 'user' }, at('2026-11-01T11:00:00+08:00')))
    const third = loadState(dir)
    assert.equal(third.rebuilt, true)
    assert.equal(third.state.stats.userTurns, 1)
  } finally {
    cleanup()
  }
})

test('store: 原子写不留半截文件', () => {
  const { dir, cleanup } = tmp()
  try {
    const file = join(dir, 'nested', 'x.json')
    writeJsonAtomic(file, { ok: 1 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ok: 1 })
    assert.equal(personaPaths(dir).profile, join(dir, 'view', 'PROFILE.md'))
  } finally {
    cleanup()
  }
})

test('render: PROFILE.md 有人话、有六轴、标明派生', () => {
  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '阿鱼', userCall: '老大' }, at('2026-11-01T10:00:00+08:00')),
    makeEvent('affect', 'dev-a', { signal: { v: 0.5, e: 0.3, t: 0 }, role: 'user' }, at('2026-11-01T10:05:00+08:00')),
  ])
  const text = renderProfile(state, at('2026-11-01T10:10:00+08:00').getTime())
  assert.match(text, /^# 阿鱼/m)
  assert.match(text, /我称他「老大」/)
  assert.match(text, /温度/)
  assert.match(text, /依恋/)
  assert.match(text, /勿手改/)
})

test('prompt: 未出生给引导，出生后给档位行为', () => {
  const seed = buildInjection(emptyState())
  assert.match(seed, /persona_seed/)

  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '阿鱼', userCall: '老大' }, at('2026-11-01T10:00:00+08:00')),
  ])
  state.mood = { v: 0.3, e: 0.6, t: 0.2, at: at('2026-11-01T10:00:00+08:00').getTime(), mode: 'low' }
  const text = buildInjection(state, at('2026-11-01T10:00:00+08:00').getTime())
  assert.match(text, /你叫阿鱼/)
  assert.match(text, /心情/)
  assert.match(text, /不要复述/)
  assert.match(text, /不确定就说不确定/)
  assert.equal(band({ v: 0.3, e: 0.6, t: 0.2 }).id, 'low')
})

test('prompt: 一条记忆都没有时提示怎么记，有记忆后不再唠叨', () => {
  const { state } = fold([makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00'))])
  const bare = buildInjection(state, Date.now(), { recordHint: true })
  assert.match(bare, /persona_remember/)
  assert.match(bare, /persona_observe/)

  const withMemory = buildInjection(state, Date.now(), { memory: '【记忆】你记得这些事：x', recordHint: true })
  assert.ok(!withMemory.includes('【记忆】还没有记忆'))

  const noHint = buildInjection(state, Date.now(), {})
  assert.ok(!noHint.includes('还没有记忆'))
})

test('prompt: 注入块不会长到失控', () => {
  const { state } = fold([makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00'))])
  assert.ok(buildInjection(state).length < 1200)
  assert.ok(seedInjection().length < 400)
})

test('render: PROFILE 分「我」和「关于老大」，USER.md 可单独拿走', () => {
  const { dir, cleanup } = tmp()
  try {
    const { state } = fold([
      makeEvent('seed', 'dev-a', { name: '阿鱼', userCall: '老大' }, at('2026-11-01T10:00:00+08:00')),
      makeEvent('page', 'dev-a', { path: 'self/job', title: '我的事', content: '我记得的事' }, at('2026-11-01T10:01:00+08:00')),
      makeEvent(
        'page',
        'dev-a',
        { path: 'people/laoda', subject: 'user', title: '老大', content: '爱打游戏', gist: '下班打游戏' },
        at('2026-11-01T10:02:00+08:00'),
      ),
      makeEvent(
        'observation',
        'dev-a',
        { key: '作息', value: '常熬夜写代码', evidence: '又是两点', confidence: 0.7 },
        at('2026-11-01T10:03:00+08:00'),
      ),
    ])
    const text = renderProfile(state, at('2026-11-01T10:10:00+08:00').getTime())
    assert.match(text, /## 关于老大/)
    assert.match(text, /观察 \*\*1\*\* 条/)
    assert.match(text, /下班打游戏/)
    assert.match(text, /view\/USER\.md/)

    writeProfile(dir, state, at('2026-11-01T10:10:00+08:00').getTime())
    assert.equal(personaPaths(dir).userModel, join(dir, 'view', 'USER.md'))
    const user = readFileSync(personaPaths(dir).userModel, 'utf8')
    assert.match(user, /# 关于老大/)
    assert.match(user, /## 观察/)
    assert.match(user, /常熬夜写代码/)
    assert.match(user, /原话「又是两点」/)
    assert.match(user, /爱打游戏/)
    assert.ok(!user.includes('我的事'), '人格记忆不能混进 USER.md')
    assert.match(readFileSync(personaPaths(dir).profile, 'utf8'), /我的事/)
  } finally {
    cleanup()
  }
})

test('fold 的 applyEvent 不认识的事件返回 false', () => {
  const state = emptyState()
  assert.equal(applyEvent(state, { kind: 'wat', at: '2026-11-01T10:00:00+08:00' }), false)
  assert.equal(applyEvent(state, null), false)
})

test('称呼可配置：seed 注入与 PROFILE 用 userName，而不是写死的「老大」', () => {
  const born = seedInjection()
  assert.match(born, /这是第一次和老大相处/)
  assert.match(seedInjection({ userName: '阿明' }), /这是第一次和阿明相处/)

  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '大肥鱼' }, at('2026-11-01T10:00:00+08:00')),
  ])
  const profile = renderProfile(state, at('2026-11-01T11:00:00+08:00').getTime(), { userName: '阿明' })
  assert.match(profile, /## 关于阿明/)
  assert.doesNotMatch(profile, /## 关于老大/)

  const seed = fold([
    makeEvent('seed', 'dev-a', { name: '大肥鱼', userCall: '老板' }, at('2026-11-01T10:00:00+08:00')),
  ])
  assert.match(
    renderProfile(seed.state, at('2026-11-01T11:00:00+08:00').getTime(), { userName: '阿明' }),
    /## 关于老板/,
    'seed 里记下的称呼优先于配置',
  )
})

test('reset all 把观察一起清掉，回到出生前', () => {
  const { state } = fold([
    makeEvent('seed', 'dev-a', { name: '阿鱼' }, at('2026-11-01T10:00:00+08:00')),
    makeEvent(
      'observation',
      'dev-a',
      { key: '作息', value: '常熬夜', evidence: '又两点睡', confidence: 0.7 },
      at('2026-11-01T10:01:00+08:00'),
    ),
    makeEvent('reset', 'dev-a', { scope: 'all' }, at('2026-11-01T10:02:00+08:00')),
  ])
  assert.deepEqual(Object.keys(state.observations), [])
  assert.equal(state.phase, 'seed')
})
