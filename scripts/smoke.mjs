// 手动冒烟：走一遍「出生 → 八轮对话 → 关系变化 → 突变 → 看注入和 PROFILE」
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { default: apply, __setDefineTool } = await import(new URL('../index.js', import.meta.url).href)

__setDefineTool((d) => d)
const dir = mkdtempSync(join(tmpdir(), 'persona-smoke-'))
const ctx = {
  logger: { info() {}, warn(m) { console.log('WARN', m) }, debug() {} },
  prompt: null,
  handlers: new Map(),
  registered: [],
  systemPrompt: { context(e) { ctx.prompt = e; return () => {} } },
  on(n, h) { ctx.handlers.set(n, h); return () => {} },
  effect(fn) { fn() },
  tools: { register(t) { ctx.registered.push(t) } },
}
apply(ctx, { dataDir: dir, dshHome: join(dir, '.dsh'), deviceId: 'smoke', journal: { git: false }, mood: { debounceMs: 0 } })
await new Promise((r) => setTimeout(r, 30))

const seed = ctx.registered.find((t) => t.name === 'persona_seed')
console.log('出生前注入:\n' + ctx.prompt.text() + '\n')
await seed.execute({ name: '阿鱼', gender: '女', user_call: '老大' })

const fire = ctx.handlers.get('session/event')
const lines = [
  '谢谢你，真靠谱',
  '今天加班到十点，累死了',
  '这个方案不行，重做吧',
  '快点快点，线上挂了',
  '哈哈哈你这句话笑死我了',
  '嗯',
  '帮我看看这个报错',
  '你确定吗？再想想',
]
for (const text of lines) {
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  await new Promise((r) => setTimeout(r, 2))
}
await new Promise((r) => setTimeout(r, 30))

const state = ctx.registered.find((t) => t.name === 'persona_state')
console.log('state:\n' + (await state.execute()) + '\n')
console.log('注入:\n' + ctx.prompt.text() + '\n')

const bond = ctx.registered.find((t) => t.name === 'persona_bond')
const shift = ctx.registered.find((t) => t.name === 'persona_shift')

async function stateForInspect() {
  return state.execute()
}
console.log('关系-起疙瘩:\n' + (await bond.execute({ action: 'rift', why: '说好的事没做到', evidence: '这个方案不行，重做吧', gist: '方案被推翻' })) + '\n')
console.log('关系-老大道歉（自动浇凉）:\n' + (await (async () => {
  fire({}, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '对不起，这次是我不好，别生气了' }] } })
  await new Promise((r) => setTimeout(r, 30))
  return stateForInspect()
})()) + '\n')
console.log('关系-我也道歉（再凉一点）:\n' + (await (async () => {
  fire({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '抱歉，是我没做好。' }] } } })
  await new Promise((r) => setTimeout(r, 30))
  return stateForInspect()
})()) + '\n')
console.log('突变:\n' + (await shift.execute({ axis: 'rigor', delta: 0.05, evidence: '你确定吗？再想想', gist: '开始习惯被追问' })) + '\n')
console.log('突变-冷却拦住:\n' + (await shift.execute({ axis: 'rigor', delta: 0.05, evidence: '你确定吗？再想想' })) + '\n')

const remember = ctx.registered.find((t) => t.name === 'persona_remember')
const recall = ctx.registered.find((t) => t.name === 'persona_recall')
console.log('记忆-记一条:\n' + (await remember.execute({ title: '老大在改类脑', content: '正在给类脑加记忆页，三步：内容、索引、强度。', path: 'projects/leinao', tags: '类脑,项目' })) + '\n')
console.log('记忆-召回:\n' + (await recall.execute({ query: '类脑' })) + '\n')

console.log('state（变动后）:\n' + (await state.execute()) + '\n')
await new Promise((r) => setTimeout(r, 50))
console.log('PROFILE:\n' + readFileSync(join(dir, 'view', 'PROFILE.md'), 'utf8'))
