import test from 'node:test'
import assert from 'node:assert/strict'

import { makeEvent } from '../src/journal.js'
import { emptyState, fold } from '../src/replay.js'
import { MEMORY, foldCandidates, memoryIndex, memoryStats, searchPages, strengthOf } from '../src/memory.js'
import { buildInjection } from '../src/prompt.js'
import { registerPersonaTools } from '../src/tools.js'

const at = (iso) => new Date(iso)
const DAY = 86400000

function page(overrides = {}) {
  return {
    path: 'people/laoda',
    title: '老大',
    content: '程序员，爱打游戏',
    gist: '写代码为生',
    tags: ['老大'],
    salience: 2,
    at: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
    recallCount: 0,
    lastRecallAt: null,
    ...overrides,
  }
}

test('replay: page 补齐默认值，同 path 再写是更新', () => {
  const { state } = fold([
    makeEvent('page', 'dev', { path: 'people/laoda', title: '老大', content: '程序员', tags: ['老大'] }, at('2026-10-01T10:00:00+08:00')),
    makeEvent('page', 'dev', { path: 'people/laoda', content: '程序员，爱打游戏' }, at('2026-10-02T10:00:00+08:00')),
  ])
  const saved = state.pages['people/laoda']
  assert.equal(saved.title, '老大')
  assert.equal(saved.content, '程序员，爱打游戏')
  assert.deepEqual(saved.tags, ['老大'])
  assert.equal(saved.salience, 2)
  assert.equal(saved.recallCount, 0)
  assert.equal(saved.updatedAt, '2026-10-02T10:00:00+08:00')
})

test('replay: recall 计数、fold 标记原页并生成整理页、forget 软删', () => {
  const { state } = fold([
    makeEvent('page', 'dev', { path: 'a', title: 'A', content: 'one', tags: ['x'] }, at('2026-10-01T10:00:00+08:00')),
    makeEvent('page', 'dev', { path: 'b', title: 'B', content: 'two', tags: ['x'] }, at('2026-10-01T10:00:00+08:00')),
    makeEvent('recall', 'dev', { path: 'a', via: 'tool' }, at('2026-10-02T10:00:00+08:00')),
    makeEvent('fold', 'dev', { into: 'digest/x', from: ['a', 'b'], title: 'X 合集', content: '- one', gist: 'x 合集' }, at('2026-10-03T10:00:00+08:00')),
    makeEvent('forget', 'dev', { path: 'digest/x' }, at('2026-10-04T10:00:00+08:00')),
  ])
  assert.equal(state.pages.a.supersededBy, 'digest/x')
  assert.equal(state.pages.a.recallCount, 1)
  assert.equal(state.pages.a.lastRecallVia, 'tool')
  assert.deepEqual([...state.pages['digest/x'].sources].sort(), ['a', 'b'])
  assert.equal(state.pages['digest/x'].kind, 'fold')
  assert.ok(state.pages['digest/x'].forgottenAt)
})

test('memory: 强度随时间减半，salience 1 不衰减，召回有加成', () => {
  const start = Date.parse('2026-01-01T00:00:00Z')
  const saved = page({ updatedAt: '2026-01-01T00:00:00Z' })
  assert.ok(Math.abs(strengthOf(saved, start) - 0.6) < 1e-9)
  assert.ok(Math.abs(strengthOf(saved, start + 21 * DAY) - 0.3) < 1e-6)
  assert.equal(strengthOf({ ...saved, salience: 1 }, start + 999 * DAY), 1)
  assert.ok(strengthOf({ ...saved, recallCount: 2 }, start) > strengthOf(saved, start))
})

test('memory: 索引固定 salience 1、按标签命中补位，忘了/被折叠的不出现', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const state = {
    pages: {
      'people/laoda': page({ salience: 1, lastRecallAt: '2026-01-01T00:00:00Z' }),
      'work/job': page({ path: 'work/job', title: '换工作', gist: '去了新公司', tags: ['工作'], updatedAt: '2026-10-01T00:00:00Z' }),
      'old/x': page({ path: 'old/x', title: '旧事', tags: ['旧'], updatedAt: '2026-01-01T00:00:00Z' }),
      'gone/y': page({ path: 'gone/y', title: '忘了', tags: ['工作'], forgottenAt: '2026-10-01T00:00:00Z' }),
    },
  }
  const index = memoryIndex(state, now, '最近工作好累')
  assert.match(index.text, /people\/laoda/)
  assert.match(index.text, /work\/job/)
  assert.doesNotMatch(index.text, /gone\/y/)
  assert.doesNotMatch(index.text, /old\/x/)
  assert.deepEqual(index.selected.map((item) => item.via), ['fixed', 'hit'])
  assert.ok(index.text.length <= MEMORY.indexMaxChars)
})

test('memory: 折叠候选按 tag 聚冷页，重要页和新页不算', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const old = '2026-01-01T00:00:00Z'
  const state = {
    pages: {
      a: page({ path: 'a', tags: ['工作'], updatedAt: old }),
      b: page({ path: 'b', tags: ['工作'], updatedAt: old }),
      c: page({ path: 'c', tags: ['工作'], updatedAt: old }),
      d: page({ path: 'd', tags: ['工作'], salience: 1, updatedAt: old }),
      e: page({ path: 'e', tags: ['工作'], updatedAt: '2026-10-30T00:00:00Z' }),
    },
  }
  const groups = foldCandidates(state, now)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].tag, '工作')
  assert.deepEqual([...groups[0].paths].sort(), ['a', 'b', 'c'])
})

test('prompt: 记忆目录和整理提醒会进注入块', () => {
  const { state } = fold([makeEvent('seed', 'dev', { name: '阿鱼' }, at('2026-10-01T10:00:00+08:00'))])
  const text = buildInjection(state, Date.now(), {
    memory: '【记忆】你记得这些事：老大爱打游戏',
    reminder: '记忆整理：标签「工作」有 3 条可以压成一条',
  })
  assert.match(text, /老大爱打游戏/)
  assert.match(text, /记忆整理/)
})

function rig() {
  const tools = []
  const events = []
  let state = emptyState()
  const rt = {
    refresh: () => ({ state }),
    record(draft) {
      const { when, ...payload } = draft
      const event = makeEvent(draft.kind, 'dev-t', payload, when instanceof Date ? when : new Date())
      events.push(event)
      state = fold(events).state
      return event
    },
  }
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  registerPersonaTools(ctx, (definition) => definition, rt)
  return { tools, events, state: () => state, tool: (name) => tools.find((item) => item.name === name) }
}

test('tools: remember → recall → digest → forget 闭环', async () => {
  const { tool, state } = rig()
  const remembered = await tool('persona_remember').execute({
    title: '老大爱打游戏',
    content: '下班常打游戏，周末看剧',
    path: 'people/laoda',
    tags: '老大,生活',
  })
  assert.match(remembered, /记下了/)
  assert.equal(state().pages['people/laoda'].title, '老大爱打游戏')
  assert.deepEqual(state().pages['people/laoda'].tags, ['老大', '生活'])

  const recalled = await tool('persona_recall').execute({ query: '打游戏' })
  assert.match(recalled, /下班常打游戏/)
  assert.equal(state().pages['people/laoda'].recallCount, 1)

  await tool('persona_remember').execute({ title: '换工作', content: '去了新公司', path: 'events/job', tags: '生活' })
  const digested = await tool('persona_digest').execute({ paths: 'people/laoda,events/job', title: '生活合集', tag: '生活' })
  assert.match(digested, /整理好了/)

  const foldPage = Object.values(state().pages).find((item) => item.kind === 'fold')
  assert.ok(foldPage)
  assert.deepEqual([...foldPage.sources].sort(), ['events/job', 'people/laoda'])
  assert.equal(state().pages['people/laoda'].supersededBy, foldPage.path)

  const forgotten = await tool('persona_forget').execute({ path: foldPage.path, why: '测试' })
  assert.match(forgotten, /忘了/)
  assert.match(await tool('persona_recall').execute({ query: '生活合集' }), /没找到/)
})

test('tools: 非法 path 不写、state 带记忆统计', async () => {
  const { tool, state } = rig()
  assert.match(await tool('persona_remember').execute({ title: 'x', content: 'y', path: 'People/老大' }), /没有记/)
  assert.equal(Object.keys(state().pages).length, 0)

  assert.match(await tool('persona_remember').execute({ title: '老大爱打游戏', content: '下班常打游戏' }), /记下了/)
  await tool('persona_seed').execute({ name: '阿鱼' })
  const text = await tool('persona_state').execute()
  assert.match(text, /记忆：1 条在册/)
})

test('replay: page 的 links 归一化、更新不带 links 时保留；fold 继承邻居', () => {
  const at2 = (day) => at(`2026-10-0${day}T10:00:00+08:00`)
  const { state } = fold([
    makeEvent('page', 'dev', { path: 'people/laoda', title: '老大', content: '程序员' }, at2(1)),
    makeEvent('page', 'dev', { path: 'events/job', title: '换工作', content: '去了新公司', links: 'People/Laoda, events/perm' }, at2(2)),
    makeEvent('page', 'dev', { path: 'events/job', content: '去了新公司，做后端' }, at2(3)),
    makeEvent('page', 'dev', { path: 'people/x', title: 'X', content: 'c', links: ['people/laoda', 'people/y'] }, at2(3)),
    makeEvent('page', 'dev', { path: 'people/y', title: 'Y', content: 'c', links: ['events/job'] }, at2(3)),
    makeEvent('fold', 'dev', { into: 'digest/x', from: ['people/x', 'people/y'], title: 'X 合集' }, at2(4)),
  ])
  assert.deepEqual(state.pages['events/job'].links, ['people/laoda', 'events/perm'])
  // 被折叠页的链接继承过来；指向被折叠页自己的那条丢掉
  assert.deepEqual(state.pages['digest/x'].links, ['people/laoda', 'events/job'])
  assert.equal(state.pages['people/y'].supersededBy, 'digest/x')
})

test('memory: 命中页的邻居补半档，强度太低的邻居不复活', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const state = {
    pages: {
      'work/job': page({
        path: 'work/job',
        title: '换工作',
        tags: ['工作'],
        updatedAt: '2026-11-01T00:00:00Z',
        links: ['people/laoda', 'old/x'],
      }),
      'people/laoda': page({ path: 'people/laoda', title: '老大', tags: ['人'], updatedAt: '2026-10-11T00:00:00Z' }),
      'old/x': page({ path: 'old/x', title: '很久以前', tags: ['旧'], updatedAt: '2025-01-01T00:00:00Z' }),
    },
  }
  const index = memoryIndex(state, now, '工作')
  const paths = index.selected.map((item) => item.path)
  assert.ok(paths.includes('work/job'))
  assert.ok(paths.includes('people/laoda'))
  assert.ok(index.selected.find((item) => item.path === 'people/laoda').linked)
  assert.ok(!paths.includes('old/x'))

  const found = searchPages(state, '换工作', 3).map((page) => page.path)
  assert.equal(found[0], 'work/job')
  assert.ok(found.includes('people/laoda'))
})

test('memory: 统计有互链的页和孤立页', () => {
  const state = { pages: { a: page({ path: 'a', links: ['b'] }), b: page({ path: 'b' }), c: page({ path: 'c' }) } }
  const stats = memoryStats(state)
  assert.equal(stats.visible, 3)
  assert.equal(stats.linked, 1)
  assert.equal(stats.isolated, 1)
})

test('tools: remember 的 links 只收存在且可见的页，不填时保留原关系', async () => {
  const { tool, state } = rig()
  await tool('persona_remember').execute({ title: '老大', content: '程序员', path: 'people/laoda' })
  const saved = await tool('persona_remember').execute({
    title: '换工作',
    content: '去了新公司',
    path: 'events/job',
    links: 'people/laoda,missing/page',
  })
  assert.match(saved, /关联 1 条/)
  assert.match(saved, /已忽略/)
  assert.deepEqual(state().pages['events/job'].links, ['people/laoda'])

  await tool('persona_remember').execute({ title: '换工作', content: '更新一下', path: 'events/job' })
  assert.deepEqual(state().pages['events/job'].links, ['people/laoda'])

  const recalled = await tool('persona_recall').execute({ path: 'events/job' })
  assert.match(recalled, /相关：people\/laoda/)
})
