import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, journalFile, makeEvent, newEventId, scanEvents } from '../src/journal.js'
import { AXES, checkGrowth, clamp01, crossedSteps, defaultTraits, growthGate, growthResistance } from '../src/traits.js'
import { applySignal, band, baseline, decay, BANDS } from '../src/mood.js'
import { appraise } from '../src/appraisal.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'persona-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('journal: append 后可扫描，按时间排序并按 id 去重', () => {
  const { dir, cleanup } = tmp()
  try {
    const early = makeEvent('affect', 'dev-a', { signal: { v: 0, e: 0, t: 0 } }, new Date('2026-11-01T09:00:00+08:00'))
    const late = makeEvent('affect', 'dev-a', { signal: { v: 0, e: 0, t: 0 } }, new Date('2026-11-01T10:00:00+08:00'))
    appendEvent(dir, 'dev-a', late)
    appendEvent(dir, 'dev-a', early)
    appendEvent(dir, 'dev-b', { ...early, id: 'dev-b-1' })
    appendEvent(dir, 'dev-a', early) // 重复 id

    const { events, stats } = scanEvents(dir)
    assert.equal(events.length, 3)
    assert.equal(stats.files, 2)
    assert.equal(events[0].id, early.id)
    assert.equal(events[1].id, 'dev-b-1')
    assert.equal(events[2].id, late.id)
  } finally {
    cleanup()
  }
})

test('journal: 坏行跳过但不拖垮整体', () => {
  const { dir, cleanup } = tmp()
  try {
    const event = makeEvent('seed', 'dev-a', { name: '鱼' }, new Date('2026-11-01T09:00:00+08:00'))
    appendEvent(dir, 'dev-a', event)
    appendFileSync(journalFile(dir, 'dev-a', new Date('2026-11-01T09:00:00+08:00')), '{"broken":\n', 'utf8')
    const { events, stats } = scanEvents(dir)
    assert.equal(events.length, 1)
    assert.equal(stats.bad, 1)
  } finally {
    cleanup()
  }
})

test('journal: 本地时间带偏移，跨月文件按事件时间分', () => {
  const id = newEventId('dev-a', new Date('2026-12-31T23:59:00+08:00'))
  assert.match(id, /^dev-a-\d{8}T\d{9}-\d{3}-[0-9a-f]{4}$/)
  const file = journalFile('/x', 'dev-a', new Date('2026-12-31T23:59:00+08:00'))
  assert.match(file, /dev-a[/\\]2026-12\.jsonl$/)
})

test('journal: 同一秒内连续写入的事件，id 必须保持写入顺序', () => {
  const at = new Date('2026-11-04T11:35:43+08:00')
  const a = makeEvent('seed', 'dev-a', { name: '阿鱼' }, at)
  const b = makeEvent('reset', 'dev-a', { scope: 'all' }, at)
  assert.ok(a.id < b.id, `${a.id} 应该排在 ${b.id} 之前`)
})

test('traits: 默认全 0.5，钳制与阻力单调', () => {
  const traits = defaultTraits()
  for (const axis of AXES) assert.equal(traits[axis].v, 0.5)
  assert.equal(clamp01(-1), 0)
  assert.equal(clamp01(2), 1)
  assert.equal(clamp01(Number.NaN), 0.5)
  assert.ok(growthResistance(0) > growthResistance(10))
})

test('traits: 前期不许成长', () => {
  const traits = defaultTraits()
  const state = { traits, stats: { userTurns: 3, firstEventAt: '2026-11-01T00:00:00+08:00', lastEventAt: '2026-11-03T00:00:00+08:00' } }
  const gate = growthGate(state)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'too-early')
})

test('traits: 成长护栏（幅度/日上限/pin/证据）', () => {
  const traits = defaultTraits()
  const state = {
    traits,
    stats: { userTurns: 40, firstEventAt: '2026-11-01T00:00:00+08:00', lastEventAt: '2026-11-03T00:00:00+08:00' },
  }
  const evidence = [{ sessionId: 's1', seq: 3 }]
  assert.equal(checkGrowth(state, { axis: 'warmth', delta: 0.02, evidence }).ok, true)
  assert.equal(checkGrowth(state, { axis: 'warmth', delta: 0.05, evidence }).code, 'delta-too-large')
  assert.equal(checkGrowth(state, { axis: 'warmth', delta: 0.02, evidence, todayTotal: 0.05 }).code, 'daily-cap')
  assert.equal(checkGrowth(state, { axis: 'warmth', delta: 0.02 }).code, 'no-evidence')
  assert.equal(checkGrowth(state, { axis: 'nope', delta: 0.02, evidence }).code, 'unknown-axis')

  state.traits.rigor.pinned = true
  assert.equal(checkGrowth(state, { axis: 'rigor', delta: 0.02, evidence }).code, 'pinned')
})

test('traits: 跨 0.1 刻度只报跨过的那几个', () => {
  assert.deepEqual(crossedSteps(0.5, 0.71), [0.6, 0.7])
  assert.deepEqual(crossedSteps(0.9, 0.88), [0.9])
  assert.deepEqual(crossedSteps(0.4, 0.4), [])
})

test('mood: 中性性格的基线是 0.5/0.5/0.5，档位为 focused', () => {
  const base = baseline(defaultTraits())
  assert.equal(base.v.toFixed(2), '0.50')
  assert.equal(base.e.toFixed(2), '0.50')
  assert.equal(base.t.toFixed(2), '0.50')
  assert.equal(band(base).id, 'focused')
})

test('mood: 六小时衰减一半路程', () => {
  const base = { v: 0.5, e: 0.5, t: 0.5 }
  const out = decay({ v: 1, e: 0.5, t: 0.5, at: 0 }, base, 6 * 3600 * 1000)
  assert.equal(out.v.toFixed(3), '0.750')
})

test('mood: 档位优先级（紧绷压过其它）', () => {
  assert.equal(band({ v: 0.9, e: 0.9, t: 0.8 }).id, 'tense')
  assert.equal(band({ v: 0.2, e: 0.9, t: 0.1 }).id, 'low')
  assert.equal(band({ v: 0.9, e: 0.2, t: 0.1 }).id, 'tired')
  assert.equal(band({ v: 0.8, e: 0.7, t: 0.1 }).id, 'excited')
  assert.equal(band({ v: 0.6, e: 0.6, t: 0.3 }).id, 'relaxed')
  assert.equal(BANDS.length, 6)
})

test('mood: 单次偏移有上限，性格放大情绪', () => {
  const traits = defaultTraits()
  traits.warmth.v = 0.9
  const out = applySignal({ v: 0.5, e: 0.5, t: 0.3, at: 0 }, traits, { v: -1, e: 0.5, t: 0.8 }, 0.15, 1000)
  assert.ok(out.v >= 0.4 - 1e-9, `v=${out.v}`)
  assert.ok(out.t <= 0.41, `t=${out.t}`)
})

test('appraisal: 表扬/责备/紧急/深夜各自给信号', () => {
  const praise = appraise({ text: '谢谢你，真靠谱', at: new Date('2026-11-04T15:00:00+08:00').getTime() })
  assert.ok(praise.v > 0.4)
  assert.ok(praise.why.includes('praise'))

  const blame = appraise({ text: '这不对，你又搞错了', at: new Date('2026-11-04T15:00:00+08:00').getTime() })
  assert.ok(blame.v < 0)
  assert.ok(blame.t > 0)

  const urgent = appraise({ text: '线上挂了，赶紧看', at: new Date('2026-11-04T15:00:00+08:00').getTime() })
  assert.ok(urgent.t > 0)

  const late = appraise({ text: '在吗', at: new Date('2026-11-04T02:00:00+08:00').getTime() })
  assert.ok(late.e < 0)
  assert.ok(late.why.includes('late-night'))
})

test('appraisal: 空文本和 tool 报错也安全', () => {
  const empty = appraise({ text: '', at: 0 })
  assert.deepEqual([empty.v, empty.e, empty.t], [0, 0, 0])
  const bad = appraise({ text: '嗯', at: 0, toolErrors: true })
  assert.ok(bad.t > 0)
  assert.ok(bad.why.includes('tool-error'))
})
