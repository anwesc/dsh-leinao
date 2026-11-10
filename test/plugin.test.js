import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import apply, { __setDefineTool } from '../index.js'
import { scanEvents } from '../src/journal.js'
import { fold } from '../src/replay.js'

/**
 * 假的 cordis ctx：只实现插件实际用到的五样东西。
 * 这个测试的价值是"接缝对不对"——注入块有没有生成、事件有没有写进 journal、
 * 非用户消息会不会被误判、工具能不能单独跑通。
 */
function fakeCtx() {
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    prompt: null,
    prompts: {},
    handlers: new Map(),
    registered: [],
    disposers: [],
    systemPrompt: {
      context(entry) {
        ctx.prompts[entry.name] = entry
        if (entry.name === 'persona') ctx.prompt = entry
        return () => {}
      },
    },
    on(name, handler) {
      ctx.handlers.set(name, handler)
      return () => ctx.handlers.delete(name)
    },
    effect(fn) {
      ctx.disposers.push(fn())
    },
    tools: {
      register(tool) {
        ctx.registered.push(tool)
      },
    },
    commands: {
      register(definition) {
        ctx.commandsRegistered.push(definition)
        return () => {}
      },
    },
    commandsRegistered: [],
    inject(names, callback) {
      if (names.includes('commands')) callback(ctx)
    },
  }
  return ctx
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-plugin-'))
  const ctx = fakeCtx()
  __setDefineTool((definition) => definition)
  apply(ctx, {
    dataDir: dir,
    dshHome: join(dir, '.dsh'),
    deviceId: 'dev-test',
    journal: { git: false },
    mood: { debounceMs: 0 },
    ...extra,
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, ctx }
}

test('plugin: 注册了 prompt 上下文和 session/event 监听', async (t) => {
  const { ctx } = setup(t)
  assert.equal(ctx.prompt.order, 130)
  assert.equal(ctx.prompt.interpolate, false)
  assert.ok(ctx.handlers.has('session/event'))
  await wait(20)
  assert.deepEqual(ctx.registered.map((tool) => tool.name).sort(), [
    'persona_bond',
    'persona_digest',
    'persona_export',
    'persona_forget',
    'persona_observe',
    'persona_pin',
    'persona_recall',
    'persona_remember',
    'persona_reset',
    'persona_seed',
    'persona_shift',
    'persona_state',
  ])
})

test('plugin: 出生前注入引导，出生后注入人格与档位', async (t) => {
  const { ctx } = setup(t)
  assert.match(ctx.prompt.text(), /persona_seed/)

  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  const out = await seed.execute({ name: '阿鱼', user_call: '老大' })
  assert.match(out, /记住了/)

  const text = ctx.prompt.text()
  assert.match(text, /你叫阿鱼/)
  assert.match(text, /老大/)
  assert.match(text, /这一档的说话方式/)
})

test('plugin: 用户消息写入 affect 事件并推动心情', async (t) => {
  const { dir, ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })

  const fire = ctx.handlers.get('session/event')
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '谢谢你，真靠谱' }] } })
  await wait(30)

  const { events } = scanEvents(dir)
  const affect = events.filter((event) => event.kind === 'affect')
  assert.equal(affect.length, 1)
  assert.ok(affect[0].signal.v > 0.2)
  assert.ok(affect[0].why.includes('praise'))

  const { state } = fold(events)
  assert.ok(state.mood.v > 0.5, `mood.v=${state.mood.v}`)
  assert.equal(state.stats.userTurns, 1)
})

test('plugin: 注入的来源不算"用户说话"', async (t) => {
  const { dir, ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })
  const fire = ctx.handlers.get('session/event')

  fire({}, { type: 'user/message', data: { source: { kind: 'skill' }, content: [{ type: 'text', text: '谢谢' }] } })
  fire({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '谢谢' }] } } })
  await wait(30)

  const { events } = scanEvents(dir)
  assert.equal(events.filter((event) => event.kind === 'affect').length, 0)
})

test('plugin: 道歉/示好自动把疙瘩浇凉，不用调 repair', async (t) => {
  const { dir, ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })
  const bond = ctx.registered.find((tool) => tool.name === 'persona_bond')
  const fire = ctx.handlers.get('session/event')

  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个方案我推翻了，昨天说的不算' }] } })
  await wait(30)
  const out = await bond.execute({ action: 'rift', why: '方案被推翻', evidence: '这个方案我推翻了', gist: '方案被推翻' })
  assert.match(out, /疙瘩/)

  // 老大道歉 → 自动 mend
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '对不起，这次是我不好，别生气了' }] } })
  await wait(60)

  const { events } = scanEvents(dir)
  const mends = events.filter((event) => event.kind === 'bond' && event.action === 'mend')
  assert.equal(mends.length, 1)
  assert.equal(mends[0].why, 'apology:user')

  const { state } = fold(events)
  assert.ok(state.bond.rift, '一句道歉浇不灭一道中度疙瘩')
  assert.ok(state.bond.rift.heat < 0.6, `heat=${state.bond.rift?.heat}`)

  // 我也道个歉 → 再凉一点（轻一点）
  fire({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '抱歉，是我没做好，让你白等了。' }] } } })
  await wait(60)
  const after = fold(scanEvents(dir).events).state
  assert.ok(after.bond.rift.heat < state.bond.rift.heat)
})

test('plugin: 落盘 state.json 和 view/PROFILE.md，工具能读回', async (t) => {
  const { dir, ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼', gender: '女', user_call: '老大' })
  await wait(30)

  assert.ok(existsSync(join(dir, 'state.json')))
  const profile = readFileSync(join(dir, 'view', 'PROFILE.md'), 'utf8')
  assert.match(profile, /# 阿鱼/)

  const state = ctx.registered.find((tool) => tool.name === 'persona_state')
  const text = await state.execute()
  assert.match(text, /名字：阿鱼/)
  assert.match(text, /性格：/)
})

test('plugin: 突变的证据必须是用户真说过的话', async (t) => {
  const { ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼', user_call: '老大' })
  const fire = ctx.handlers.get('session/event')
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这次你做得很稳，我记住了' }] } })
  await wait(20)

  const shift = ctx.registered.find((tool) => tool.name === 'persona_shift')
  assert.match(await shift.execute({ axis: 'warmth', delta: 0.05, evidence: '这句根本没说过的话' }), /找不到原话/)
  assert.match(await shift.execute({ axis: 'warmth', delta: 0.05, evidence: '这次你做得很稳' }), /记下了/)

  const state = ctx.registered.find((tool) => tool.name === 'persona_state')
  assert.match(await state.execute(), /突变：1 次/)
})

test('plugin: 记忆进注入、命中记弱召回、到点提整理', async (t) => {
  const { dir, ctx } = setup(t, {
    memory: { strongThreshold: 0.7, foldBelowStrength: 0.99, foldAfterDays: 0, foldMinGroup: 1, foldEveryTurns: 1 },
  })
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })
  await ctx.registered.find((tool) => tool.name === 'persona_remember').execute({
    title: '老大爱打游戏',
    content: '下班常打游戏，周末看剧',
    path: 'people/laoda',
    tags: '老大,生活',
  })
  await ctx.registered.find((tool) => tool.name === 'persona_remember').execute({
    title: '我叫阿鱼',
    content: '老大起的名字',
    path: 'people/me',
    tags: '名字',
    salience: 1,
  })

  // salience 1 每轮固定出现
  assert.match(ctx.prompt.text(), /【记忆】/)
  assert.match(ctx.prompt.text(), /我叫阿鱼/)

  const fire = ctx.handlers.get('session/event')
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '老大今天好累' }] } })
  await wait(40)

  const { events } = scanEvents(dir)
  assert.ok(
    events.some((event) => event.kind === 'recall' && event.path === 'people/laoda' && event.via === 'inject'),
    '标签命中应当记一条弱召回',
  )
  const text = ctx.prompt.text()
  assert.match(text, /老大爱打游戏/)
  assert.match(text, /记忆整理/)
})

test('plugin: 用户模型单独一块注入，和人格记忆分开', async (t) => {
  const { ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼', user_call: '老大' })
  const remember = ctx.registered.find((tool) => tool.name === 'persona_remember')
  await remember.execute({ subject: 'user', title: '老大爱打游戏', content: '下班常打游戏', path: 'people/laoda' })

  // 观察必须有原话证据；没说过的话不能拿来当证据
  const fire = ctx.handlers.get('session/event')
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '老大今天又两点睡，还在写代码' }] } })
  await wait(30)
  const observe = ctx.registered.find((tool) => tool.name === 'persona_observe')
  assert.match(await observe.execute({ key: '作息', value: '常熬夜', evidence: '他经常通宵' }), /找不到原话/)
  assert.match(await observe.execute({ key: '作息', value: '常熬夜写代码', evidence: '又两点睡' }), /记下了观察/)
  await wait(30)

  const block = ctx.prompts['about-user']
  assert.ok(block, '应当注册 about-user 注入块')
  assert.equal(block.order, 131)
  assert.match(block.text(), /关于老大/)
  assert.match(block.text(), /作息：常熬夜写代码/)
  assert.match(block.text(), /下班常打游戏/)
  assert.ok(!/【记忆】/.test(block.text()), '用户模型块不该带人格记忆的头')
  assert.ok(!/下班常打游戏/.test(ctx.prompt.text()), '人格块不该带用户模型的内容')
  assert.ok(!/常熬夜写代码/.test(ctx.prompt.text()), '人格块不该带观察')
})

test('plugin: /leinao proactive on|off 只影响当前会话，落盘可查', async (t) => {
  const { dir, ctx } = setup(t)
  const command = ctx.commandsRegistered.find((item) => item.name === 'leinao')
  assert.ok(command, '应注册 /leinao 命令')
  const agent = { id: 'session-abc' }

  const status0 = command.handler({ agent, rawInput: 'status' })
  assert.equal(status0.kind, 'success')
  assert.match(status0.text, /主动开口：开/)
  assert.match(status0.text, /默认/)

  const off = command.handler({ agent, rawInput: 'proactive off' })
  assert.match(off.text, /已关闭/)
  const saved = JSON.parse(readFileSync(join(dir, '.dsh', 'leinao-sessions.json'), 'utf8'))
  assert.equal(saved.sessions['session-abc'].proactive, false)

  const status1 = command.handler({ agent, rawInput: '' })
  assert.match(status1.text, /主动开口：关/)
  assert.match(status1.text, /显式关/)

  const other = command.handler({ agent: { id: 'session-other' }, rawInput: 'status' })
  assert.match(other.text, /主动开口：开/, '别的会话不受影响')

  const cleared = command.handler({ agent, rawInput: 'clear' })
  assert.match(cleared.text, /回到全局默认/)
  assert.match(command.handler({ agent, rawInput: 'nonsense' }).text, /用法/)
})

test('plugin: seed 只有一次，reset 要 confirm', async (t) => {
  const { ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼' })
  const again = await seed.execute({ name: '阿猫' })
  assert.match(again, /已经出生过了/)

  const reset = ctx.registered.find((tool) => tool.name === 'persona_reset')
  assert.match(await reset.execute({ scope: 'all' }), /没有执行/)
  assert.match(await reset.execute({ scope: 'all', confirm: true }), /已重置/)
  assert.match(ctx.prompt.text(), /persona_seed/)
})

test('plugin: 增量应用与全量重放结果一致（写事件不用整份重放）', async (t) => {
  const { dir, ctx } = setup(t)
  const tool = (name) => ctx.registered.find((item) => item.name === name)

  await tool('persona_seed').execute({ name: '阿鱼', user_call: '老大' })
  await tool('persona_remember').execute({ title: '约定', content: '周六一起打游戏', path: 'events/plan', tags: '约定' })
  await tool('persona_remember').execute({ subject: 'user', title: '作息', content: '常熬夜', path: 'people/late' })
  await tool('persona_observe').execute({ key: '作息', value: '常熬夜写代码', evidence: '又两点睡' })
  await tool('persona_bond').execute({ action: 'up', why: '配合得好' })
  await wait(30)

  const { events } = scanEvents(dir)
  const { state: replay } = fold(events)

  // 插件内存里的状态（增量 apply）应该和从头重放一模一样
  assert.match(ctx.prompt.text(), /阿鱼/)
  const cached = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(cached.meta.journal.count, events.length)
  assert.deepEqual(cached.state.pages, replay.pages)
  assert.deepEqual(cached.state.observations, replay.observations)
  assert.equal(cached.state.bond.level, replay.bond.level)
})
