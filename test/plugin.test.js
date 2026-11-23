import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import apply from '../index.js'
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

function setup(t, extra = {}, prepare) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-plugin-'))
  const ctx = fakeCtx()
  prepare?.(ctx)
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

test('plugin: 用户说「以后都这样」时，下一轮注入轻提一句，且只提一次', async (t) => {
  const { ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼', user_call: '老大' })

  const fire = ctx.handlers.get('session/event')
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后周末别给我排活' }] } })
  await wait(30)
  const nudged = ctx.prompt.text()
  assert.match(nudged, /【记忆】这句像/)
  assert.match(nudged, /闲聊，不用记/)

  // 同类信号本会话只提一次
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后也别喊我早起' }] } })
  await wait(30)
  assert.ok(!/【记忆】这句像/.test(ctx.prompt.text()))

  // 换一类信号还能提（这里冷却时间很短，避免测试等太久）
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我不喜欢太长的回复' }] } })
  await wait(30)
  assert.ok(!/【记忆】这句像/.test(ctx.prompt.text()), '冷却中不该重复提')
})

test('plugin: 同类信号十分钟内出现两次，自动记一条低置信度观察，不打扰对话', async (t) => {
  const { dir, ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼', user_call: '老大' })
  const fire = ctx.handlers.get('session/event')
  const say = (text) => fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

  say('我不喜欢太长的回复')
  await wait(25)
  let { events } = scanEvents(dir)
  assert.ok(!events.some((event) => event.kind === 'observation'), '第一次出现不该写')

  say('我不喜欢被追问细节')
  await wait(25)
  ;({ events } = scanEvents(dir))
  const auto = events.filter((event) => event.kind === 'observation')
  assert.equal(auto.length, 1)
  assert.equal(auto[0].key, '偏好')
  assert.equal(auto[0].confidence, 0.4)
  assert.equal(auto[0].evidence, '我不喜欢被追问细节')

  // 同类再出现不重复写
  say('我不喜欢太吵的地方')
  await wait(25)
  ;({ events } = scanEvents(dir))
  assert.equal(events.filter((event) => event.kind === 'observation').length, 1)

  // 自动写的内容会进用户模型，并且可以删
  const block = ctx.prompts['about-user']
  assert.match(block.text(), /偏好：我不喜欢被追问细节/)
})

test('plugin: 同类话里带密钥时，自动草稿不写', async (t) => {
  const { dir, ctx } = setup(t)
  const seed = ctx.registered.find((tool) => tool.name === 'persona_seed')
  await seed.execute({ name: '阿鱼', user_call: '老大' })
  const fire = ctx.handlers.get('session/event')
  const say = (text) => fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

  say('以后用 sk-abcdefgh12345678 这个 key')
  say('我不喜欢这个 password: hunter2')
  await wait(40)
  const { events } = scanEvents(dir)
  assert.ok(!events.some((event) => event.kind === 'observation'), '敏感信息不该落进 journal')
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
  assert.match(await reset.execute({ scope: 'all', confirm: false }), /没有执行/)
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
  ctx.handlers.get('session/event')({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这把我配合得很好' }] } })
  await tool('persona_bond').execute({ action: 'up', why: '配合得好', evidence: '配合得很好' })
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

test('plugin: 全量记录对话，敏感内容只留占位', async (t) => {
  const { dir, ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })
  const fire = ctx.handlers.get('session/event')

  fire({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后周末别排活' }] } })
  fire({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好，记下了' }] } } })
  fire({ id: 's2' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我的 key 是 sk-abcdefgh12345678' }] } })
  await wait(40)

  const { events } = scanEvents(dir)
  const messages = events.filter((event) => event.kind === 'message')
  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].text, '以后周末别排活')
  assert.equal(messages[0].session, 's1')
  assert.equal(messages[1].role, 'assistant')
  assert.match(messages[2].text, /已过滤/)
  assert.ok(!JSON.stringify(events).includes('sk-abcdefgh12345678'))

  // 消息不进 state.json，只给索引读
  const cached = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(cached.state.pages && Object.keys(cached.state.pages).length, 0)
  assert.ok(!('messages' in cached.state))
})

test('plugin: 提到以前说过的事时，召回相关片段进注入', async (t) => {
  const { ctx } = setup(t)
  await ctx.registered.find((tool) => tool.name === 'persona_seed').execute({ name: '阿鱼' })
  const fire = ctx.handlers.get('session/event')

  fire({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记忆图谱改成三栏布局，左边目录右边内容' }] } })
  await wait(20)
  fire({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记忆图谱三栏布局现在怎么样' }] } })
  await wait(20)

  const text = ctx.prompts.persona.text()
  assert.match(text, /【相关】/)
  assert.match(text, /三栏布局/)
})


test('plugin: 一轮里动过手，回合结束自动留一条工作记录', async (t) => {
  const agentHandlers = new Map()
  const agent = {
    id: 'agent-1',
    status: 'idle',
    session: { header: { cwd: 'D:/01_Code/github/dsh-leinao' } },
    inbox: { nextStep: [] },
    followup() {},
    ctx: {
      on(name, handler) {
        if (!agentHandlers.has(name)) agentHandlers.set(name, [])
        agentHandlers.get(name).push(handler)
        return () => {
          const list = agentHandlers.get(name) ?? []
          const index = list.indexOf(handler)
          if (index >= 0) list.splice(index, 1)
        }
      },
      effect(fn) {
        agentDisposers.push(fn())
      },
    },
  }
  const agentDisposers = []
  t.after(() => {
    for (const dispose of agentDisposers) dispose?.()
  })

  const { dir, ctx } = setup(t, { worklog: { enabled: true, minActions: 1 } }, (fake) => {
    fake.agents = { roots: () => [agent], get: (id) => (id === agent.id ? agent : undefined) }
  })
  ctx.handlers.get('agent/created')({ agent })

  const call = (name, args) => ctx.handlers.get('tools/result')({ name, arguments: args, agent: { id: agent.id } })
  call('read', { file_path: 'x.md' }) // 只读不算
  call('write', { file_path: 'D:/x/src/a.js' })
  call('ops_bash', { command: 'npm test' })
  call('persona_remember', { title: 'x' }) // 记忆类工具不算

  const stop = () => {
    for (const handler of agentHandlers.get('agent/turn-stopping') ?? []) handler()
  }
  stop()
  await wait(40)

  const pagesOf = (dirPath) => scanEvents(dirPath).events.filter((event) => event.kind === 'page')
  let pages = pagesOf(dir)
  assert.equal(pages.length, 1)
  assert.match(pages[0].path, /^worklog\/\d{4}-\d{2}-\d{2}\/dsh-leinao$/)
  assert.match(pages[0].content, /改 a\.js/)
  assert.match(pages[0].content, /跑 npm test/)
  assert.ok(!pages[0].content.includes('x.md'))
  assert.deepEqual(pages[0].tags, ['工作记录'])
  assert.equal(pages[0].salience, 3)

  // 同一轮再动一次手：追加到同一条，而不是新开一条
  call('edit', { file_path: 'D:/x/src/b.js' })
  stop()
  await wait(40)
  pages = pagesOf(dir)
  assert.equal(pages.length, 2)
  assert.equal(pages[1].path, pages[0].path)
  assert.match(pages[1].content, /改 a\.js/)
  assert.match(pages[1].content, /改 b\.js/)

  // 删掉之后，再干活不会把它复活
  const forget = ctx.registered.find((tool) => tool.name === 'persona_forget')
  await forget.execute({ path: pages[0].path, why: '不想要工作记录' })
  call('write', { file_path: 'D:/x/src/c.js' })
  stop()
  await wait(40)
  assert.equal(pagesOf(dir).length, 2) // 删掉的页不再长长

  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  const page = state.state.pages[pages[0].path]
  assert.ok(page.forgottenAt, '删掉的页不该被新动作复活')
})
