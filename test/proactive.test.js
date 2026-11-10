import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROACTIVE,
  ProactiveNudge,
  buildRecallMessage,
  claimProactiveLock,
  pickRecallPage,
} from '../src/proactive.js'

const at = (iso) => new Date(iso)
const NOW = at('2026-11-10T12:00:00+08:00').getTime()

function page(overrides = {}) {
  return {
    path: 'people/laoda',
    title: '老大',
    content: '程序员，爱打游戏',
    gist: '写代码为生',
    tags: ['老大'],
    salience: 1,
    subject: 'self',
    at: '2026-11-01T00:00:00+08:00',
    updatedAt: '2026-11-01T00:00:00+08:00',
    recallCount: 0,
    lastRecallAt: null,
    ...overrides,
  }
}

function stateWith(...pages) {
  return { pages: Object.fromEntries(pages.map((p) => [p.path, page(p)])) }
}

test('pickRecallPage：挑强度够、最久没被想起的一条；太弱/已忘/用户模型都不提', () => {
  const state = stateWith(
    page({ path: 'events/job', title: '换工作', salience: 1, lastRecallAt: '2026-11-08T00:00:00+08:00' }),
    page({ path: 'events/trip', title: '旅行', salience: 1, lastRecallAt: null }),
    page({ path: 'events/weak', title: '很久以前的小事', salience: 3, updatedAt: '2026-01-01T00:00:00+08:00' }),
    page({ path: 'user/habit', title: '熬夜', subject: 'user', salience: 1 }),
    page({ path: 'events/gone', title: '忘了', salience: 1, forgottenAt: '2026-11-02T00:00:00+08:00' }),
  )
  const picked = pickRecallPage(state, NOW, { minStrength: 0.35, rementionDays: 14, memory: { halfLifeDays: 21 } })
  assert.equal(picked?.path, 'events/trip', '同样强时优先从没提过的')
})

test('pickRecallPage：刚提过的不再提；全都不合适时返回 null', () => {
  const state = stateWith(page({ path: 'people/laoda', lastRecallAt: '2026-11-09T00:00:00+08:00' }))
  assert.equal(pickRecallPage(state, NOW, { minStrength: 0.1, rementionDays: 14 }), null)
  assert.equal(pickRecallPage({ pages: {} }, NOW, { minStrength: 0.1 }), null)
})

test('buildRecallMessage：带标题和摘要，source 是本插件', () => {
  const msg = buildRecallMessage(page({ title: '换工作', gist: '上个月在纠结要不要跳' }), { name: '大肥鱼', userCall: '老大' })
  assert.match(msg.id, /^leinao-recall-/)
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'plugin:leinao')
  const text = msg.content[0].text
  assert.match(text, /大肥鱼主动想起/)
  assert.match(text, /换工作/)
  assert.match(text, /上个月在纠结要不要跳/)
  assert.match(text, /不要编/)
})

test('claimProactiveLock：别人占着就让一让，自己可以续，冷却 0 直接放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-proactive-'))
  const lockPath = join(dir, 'proactive-cooldown.json')
  try {
    assert.equal(claimProactiveLock({ path: lockPath, speaker: 'memory', cooldownSeconds: 180, now: NOW }).ok, true)
    const save = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.deepEqual(save, { version: 1, speaker: 'memory', at: NOW })

    const deferred = claimProactiveLock({ path: lockPath, speaker: 'leinao', cooldownSeconds: 180, now: NOW + 30_000 })
    assert.equal(deferred.ok, false)
    assert.equal(deferred.deferredBy, 'memory')

    assert.equal(claimProactiveLock({ path: lockPath, speaker: 'memory', cooldownSeconds: 180, now: NOW + 60_000 }).ok, true)
    assert.equal(claimProactiveLock({ path: lockPath, speaker: 'leinao', cooldownSeconds: 0, now: NOW + 60_000 }).ok, true)
    assert.equal(claimProactiveLock({ path: lockPath, speaker: 'leinao', cooldownSeconds: 180, now: NOW + 241_000 }).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fakeAgent(overrides = {}) {
  const sent = []
  const agent = {
    id: 'agent-1',
    status: 'idle',
    inbox: { nextStep: [] },
    ctx: { on: () => () => {} },
    followup: (msg) => sent.push(msg),
    ...overrides,
  }
  return { agent, sent }
}

function nudgeFor(agent, extra = {}) {
  const calls = []
  const nudge = new ProactiveNudge(agent, {
    readConfig: () => ({
      ...PROACTIVE,
      minMinutes: 10,
      maxMinutes: 20,
      maxPerSession: 2,
      cooldownSeconds: 0,
      minStrength: 0.1,
      ...extra.config,
    }),
    getState: () =>
      stateWith(
        page({ path: 'events/job', title: '换工作', salience: 1 }),
        page({ path: 'people/cat', title: '猫', salience: 1, lastRecallAt: '2026-11-09T00:00:00+08:00' }),
      ),
    record: (event) => calls.push(event),
    tracker: { shouldInject: () => true },
    lockPath: undefined,
    logger: { info() {}, warn() {} },
    ...extra,
  })
  return { nudge, calls }
}

test('ProactiveNudge：第一个空闲点只校准节奏，不立刻开口', () => {
  const { agent, sent } = fakeAgent()
  const { nudge } = nudgeFor(agent)
  nudge.onTurnStopped()
  assert.equal(sent.length, 0)
  assert.ok(nudge.nextAt > Date.now())
  nudge.dispose()
})

test('ProactiveNudge：到点后开口一次并记账，不会连着刷', () => {
  const { agent, sent } = fakeAgent()
  const { nudge, calls } = nudgeFor(agent)
  nudge.nextAt = Date.now() - 1
  nudge.onTurnStopped()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].source.kind, 'plugin:leinao')
  assert.equal(calls[0]?.kind, 'recall')
  assert.equal(calls[0]?.via, 'proactive')
  assert.equal(nudge.sent, 1)

  nudge.onTurnStopped()
  assert.equal(sent.length, 1, '刚说完不会再刷一条')
  nudge.dispose()
})

test('ProactiveNudge：忙、inbox 有下一步、超上限、agent 已死时都不开口', () => {
  {
    const { agent, sent } = fakeAgent({ status: 'working' })
    const { nudge } = nudgeFor(agent)
    nudge.nextAt = Date.now() - 1
    nudge.onTurnStopped()
    assert.equal(sent.length, 0, '忙的时候不插话')
    nudge.dispose()
  }
  {
    const { agent, sent } = fakeAgent({ inbox: { nextStep: [{}] } })
    const { nudge } = nudgeFor(agent)
    nudge.nextAt = Date.now() - 1
    nudge.onTurnStopped()
    assert.equal(sent.length, 0, '还有排队的下一步时不算空闲')
    nudge.dispose()
  }
  {
    const { agent, sent } = fakeAgent()
    const { nudge } = nudgeFor(agent, { config: { maxPerSession: 1 } })
    nudge.nextAt = Date.now() - 1
    nudge.onTurnStopped()
    nudge.nextAt = Date.now() - 1
    nudge.onTurnStopped()
    assert.equal(sent.length, 1, '一次会话有上限')
    nudge.dispose()
  }
  {
    const { agent, sent } = fakeAgent()
    const { nudge } = nudgeFor(agent, { agents: { get: () => undefined } })
    nudge.nextAt = Date.now() - 1
    nudge.onTurnStopped()
    assert.equal(sent.length, 0, 'agent 已经不在 roots 里就闭嘴')
    assert.equal(nudge.disposed, true)
  }
})

test('ProactiveNudge：会话被单独关掉时闭嘴', () => {
  const { agent, sent } = fakeAgent()
  const { nudge } = nudgeFor(agent, { isEnabled: () => false })
  nudge.nextAt = Date.now() - 1
  nudge.onTurnStopped()
  assert.equal(sent.length, 0)
  nudge.dispose()
})

test('ProactiveNudge：没有合适记忆时保持沉默', () => {
  const { agent, sent } = fakeAgent()
  const { nudge } = nudgeFor(agent, { getState: () => ({ pages: {} }) })
  nudge.nextAt = Date.now() - 1
  nudge.onTurnStopped()
  assert.equal(sent.length, 0)
  nudge.dispose()
})
