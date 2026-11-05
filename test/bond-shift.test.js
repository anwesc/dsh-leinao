import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvent } from '../src/journal.js'
import { fold, intimacyOf } from '../src/replay.js'
import { checkBond, BOND, MEND, bondLabel, defaultBond, detectMend } from '../src/bond.js'
import { checkShift, SHIFT } from '../src/traits.js'
import { buildInjection } from '../src/prompt.js'
import { renderProfile } from '../src/render.js'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const DAY = 86400000

function seeded({ turns = 0, startAt = T0, gapMs = 0 } = {}) {
  const events = [makeEvent('seed', 'dev-x', { name: '阿鱼', userCall: '老大' }, new Date(startAt))]
  for (let i = 0; i < turns; i += 1) {
    events.push(makeEvent('affect', 'dev-x', { signal: { v: 0.1, e: 0.1, t: 0 }, role: 'user' }, new Date(startAt + (i + 1) * gapMs)))
  }
  return events
}

function stateAfter(events) {
  return fold(events).state
}

const evidence = '你这次真的让我失望了'

// ── 关系层 ──────────────────────────────────────────────────────────────

test('bond: 升一级要够轮次和天数', () => {
  const soon = stateAfter(seeded({ turns: 10 }))
  assert.equal(checkBond(soon, { action: 'up', evidence }, T0 + 4 * DAY).code, 'too-soon')

  const young = stateAfter(seeded({ turns: 40 }))
  assert.equal(checkBond(young, { action: 'up', evidence }, T0 + 1 * DAY).code, 'too-soon')

  assert.equal(checkBond(young, { action: 'up', evidence }, T0 + 4 * DAY).ok, true)
})

test('bond: 有裂痕不许走近，最高档不许再升', () => {
  const rift = stateAfter([...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'rift', why: '吵了一架', gist: '吵了一架' }, new Date(T0 + 2 * DAY))])
  assert.equal(checkBond(rift, { action: 'up', evidence }, T0 + 10 * DAY).code, 'rift-pending')

  const top = stateAfter(seeded({ turns: 40 }))
  top.bond = { ...defaultBond(markIso(T0)), level: BOND.maxLevel }
  assert.equal(checkBond(top, { action: 'up', evidence }, T0 + 10 * DAY).code, 'max-level')
})

test('bond: 裂痕、重复裂痕、无裂痕修复、最低档再退', () => {
  const base = stateAfter(seeded({ turns: 5 }))
  assert.equal(checkBond(base, { action: 'repair', evidence }, T0).code, 'no-rift')
  assert.equal(checkBond(base, { action: 'rift', evidence }, T0).ok, true)

  const withRift = stateAfter([...seeded({ turns: 5 }), makeEvent('bond', 'dev-x', { action: 'rift', why: 'x' }, new Date(T0 + 1000))])
  assert.equal(checkBond(withRift, { action: 'rift', evidence }, T0 + 2000).code, 'rift-exists')
  assert.equal(checkBond(withRift, { action: 'down', evidence }, T0 + 2000).code, 'already-lowest')
  assert.equal(checkBond(withRift, { action: 'repair', evidence }, T0 + 2000).ok, true)
})

test('bond: 证据太短直接拒', () => {
  const state = stateAfter(seeded({ turns: 40 }))
  assert.equal(checkBond(state, { action: 'up', evidence: '嗯' }, T0 + 4 * DAY).code, 'no-evidence')
})

test('bond: 升一级改 level/since，亲密度的台阶看得出来', () => {
  const before = stateAfter(seeded({ turns: 40 }))
  const after = stateAfter([...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'up', why: '一起扛过事', gist: '一起扛过事' }, new Date(T0 + 4 * DAY))])
  assert.equal(after.bond.level, 1)
  assert.equal(bondLabel(after.bond.level), '熟络')
  assert.ok(intimacyOf(after) > intimacyOf(before) + 0.05)
  assert.ok(after.milestones.some((m) => m.kind === 'bond'))
})

test('bond: 退一级留裂痕，亲密度的折扣比升级加成重', () => {
  const up = [...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'up', why: 'x' }, new Date(T0 + 4 * DAY))]
  const down = [...up, makeEvent('bond', 'dev-x', { action: 'down', why: '食言了', gist: '食言' }, new Date(T0 + 5 * DAY))]
  const state = stateAfter(down)
  assert.equal(state.bond.level, 0)
  assert.equal(state.bond.rift.gist, '食言')
  assert.ok(intimacyOf(state) < intimacyOf(stateAfter(seeded({ turns: 40 }))) + 0.001)
})

test('bond: repair 解掉裂痕，但不恢复等级', () => {
  const up = [...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'up', why: 'x' }, new Date(T0 + 4 * DAY))]
  const down = [...up, makeEvent('bond', 'dev-x', { action: 'down', why: 'y', gist: 'y' }, new Date(T0 + 5 * DAY))]
  const fixed = stateAfter([...down, makeEvent('bond', 'dev-x', { action: 'repair', why: '谈开了' }, new Date(T0 + 6 * DAY))])
  assert.equal(fixed.bond.rift, null)
  assert.equal(fixed.bond.level, 0)
})

// ── 裂痕的缓和（mend）──────────────────────────────────────────────────

test('bond: 道歉/示好把疙瘩一点点浇凉，浇空了才算解开', () => {
  const rift = [...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'rift', why: '吵了一架' }, new Date(T0 + DAY))]

  const one = stateAfter([...rift, makeEvent('bond', 'dev-x', { action: 'mend', delta: 0.3 }, new Date(T0 + DAY + 1000))])
  assert.equal(one.bond.rift !== null, true, '一句道歉不该立刻把疙瘩抹掉')
  assert.ok(Math.abs(one.bond.rift.heat - (MEND.riftHeat - 0.3)) < 1e-9)

  const two = stateAfter([
    ...rift,
    makeEvent('bond', 'dev-x', { action: 'mend', delta: 0.3 }, new Date(T0 + DAY + 1000)),
    makeEvent('bond', 'dev-x', { action: 'mend', delta: 0.3 }, new Date(T0 + DAY + 2000)),
  ])
  assert.equal(two.bond.rift, null)
  assert.ok(two.milestones.some((m) => m.kind === 'bond' && m.label === 'mend'))
})

test('bond: 没有疙瘩时 mend 不生效', () => {
  const folded = fold([...seeded({ turns: 5 }), makeEvent('bond', 'dev-x', { action: 'mend', delta: 0.3 }, new Date(T0 + 1000))])
  assert.equal(folded.state.bond.rift, null)
  assert.equal(folded.diagnostics.skippedKinds.bond, 1)
})

test('bond: 疙瘩越重，亲密度扣得越多；浇凉了扣得就少', () => {
  const down = stateAfter([...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'down', why: 'x' }, new Date(T0 + 5 * DAY))])
  const rift = stateAfter([...seeded({ turns: 40 }), makeEvent('bond', 'dev-x', { action: 'rift', why: 'x' }, new Date(T0 + 5 * DAY))])
  assert.ok(intimacyOf(down) < intimacyOf(rift), '掉级比只起疙瘩更伤')

  const cooled = stateAfter([
    ...seeded({ turns: 40 }),
    makeEvent('bond', 'dev-x', { action: 'down', why: 'x' }, new Date(T0 + 5 * DAY)),
    makeEvent('bond', 'dev-x', { action: 'mend', delta: 0.4 }, new Date(T0 + 5 * DAY + 1000)),
  ])
  assert.ok(intimacyOf(cooled) > intimacyOf(down))
})

test('bond: 认得出哪些话在给台阶', () => {
  assert.deepEqual(detectMend('对不起，这次是我不好'), { delta: MEND.userApology, why: 'apology:user' })
  assert.equal(detectMend('这事翻篇吧，我们不吵了').why, 'warmth:user')
  assert.equal(detectMend('抱歉，我刚才急了', 'assistant').delta, MEND.assistantApology)
  assert.equal(detectMend('这个函数要改成异步'), null)
})

// ── 性格突变 ────────────────────────────────────────────────────────────

test('shift: 正常一次突变', () => {
  const state = stateAfter(seeded({ turns: 40 }))
  const verdict = checkShift(state, { axis: 'warmth', delta: 0.05, evidence }, { nowMs: T0 + 30 * DAY })
  assert.equal(verdict.ok, true)
})

test('shift: 幅度、证据长度、核验失败、pinned 都拦得住', () => {
  const state = stateAfter(seeded({ turns: 40 }))
  const now = T0 + 30 * DAY
  assert.equal(checkShift(state, { axis: 'warmth', delta: 0.06, evidence }, { nowMs: now }).code, 'delta-too-large')
  assert.equal(checkShift(state, { axis: 'warmth', delta: 0.05, evidence: '你' }, { nowMs: now }).code, 'no-evidence')
  assert.equal(checkShift(state, { axis: 'warmth', delta: 0.05, evidence }, { nowMs: now, verified: false }).code, 'evidence-mismatch')

  const pinned = stateAfter(seeded({ turns: 40 }))
  pinned.traits.warmth.pinned = true
  assert.equal(checkShift(pinned, { axis: 'warmth', delta: 0.05, evidence }, { nowMs: now }).code, 'pinned')
  assert.equal(checkShift(state, { axis: 'nope', delta: 0.05, evidence }, { nowMs: now }).code, 'unknown-axis')
})

test('shift: 冷却 7 天，90 天最多 4 次', () => {
  const one = [...seeded({ turns: 40 }), makeEvent('shift', 'dev-x', { axis: 'warmth', delta: 0.05, evidence, gist: 'x' }, new Date(T0 + 30 * DAY))]
  const state = stateAfter(one)
  assert.equal(checkShift(state, { axis: 'warmth', delta: 0.05, evidence }, { nowMs: T0 + 32 * DAY }).code, 'cooldown')

  const many = [...seeded({ turns: 40 })]
  for (let i = 0; i < 4; i += 1) {
    many.push(makeEvent('shift', 'dev-x', { axis: 'warmth', delta: 0.04, evidence, gist: `第 ${i} 次` }, new Date(T0 + (30 + i * 8) * DAY)))
  }
  assert.equal(checkShift(stateAfter(many), { axis: 'warmth', delta: 0.04, evidence }, { nowMs: T0 + 65 * DAY }).code, 'shift-cap')
})

test('shift: 重放按原值推动（没有成长阻力），并写进 shifts 与里程碑', () => {
  const events = [...seeded({ turns: 10 }), makeEvent('shift', 'dev-x', { axis: 'warmth', delta: 0.05, evidence, gist: '那天他说了实话' }, new Date(T0 + 1000))]
  // 0.5 → 0.55，先加 0.09 才跨 0.6，所以再补一次突变看里程碑
  const state = stateAfter(events)
  assert.equal(Math.round(state.traits.warmth.v * 100) / 100, 0.55)
  assert.equal(state.shifts.length, 1)

  const crossing = stateAfter([...events, makeEvent('shift', 'dev-x', { axis: 'warmth', delta: 0.05, evidence, gist: 'y' }, new Date(T0 + 2000))])
  assert.ok(crossing.milestones.some((m) => m.kind === 'shift' && m.axis === 'warmth' && m.step === 0.6))
})

test('reset all 也清掉关系与突变历史', () => {
  const events = [
    ...seeded({ turns: 40 }),
    makeEvent('bond', 'dev-x', { action: 'up', why: 'x' }, new Date(T0 + 4 * DAY)),
    makeEvent('shift', 'dev-x', { axis: 'warmth', delta: 0.05, evidence }, new Date(T0 + 30 * DAY)),
    makeEvent('reset', 'dev-x', { scope: 'all' }, new Date(T0 + 31 * DAY)),
  ]
  const state = stateAfter(events)
  assert.equal(state.phase, 'seed')
  assert.equal(state.bond.level, 0)
  assert.equal(state.shifts.length, 0)
})

// ── 展示层 ──────────────────────────────────────────────────────────────

test('注入与 PROFILE 都能看出关系；裂痕会多一句提醒', () => {
  const events = [
    ...seeded({ turns: 40 }),
    makeEvent('bond', 'dev-x', { action: 'up', why: 'x' }, new Date(T0 + 4 * DAY)),
    makeEvent('bond', 'dev-x', { action: 'rift', why: '吵了一架', gist: '吵了一架' }, new Date(T0 + 5 * DAY)),
  ]
  const state = stateAfter(events)
  const injection = buildInjection(state, T0 + 6 * DAY)
  assert.match(injection, /关系：熟络/)
  assert.match(injection, /疙瘩/)
  assert.match(injection, /别装没事/)

  const profile = renderProfile(state, T0 + 6 * DAY)
  assert.match(profile, /## 关系/)
  assert.match(profile, /疙瘩：\*\*未解/)
})

function markIso(ms) {
  return new Date(ms).toISOString()
}
