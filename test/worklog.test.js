import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKLOG,
  buildWorklogSegment,
  createWorklogBuffer,
  describeAction,
  mergeWorklog,
  worklogPath,
  worklogSlug,
} from '../src/worklog.js'

test('describeAction 只把动手的动作翻成人话', () => {
  assert.equal(describeAction('write', { file_path: 'D:/a/b/src/worklog.js' }), '改 worklog.js')
  assert.equal(describeAction('ops_bash', { command: 'npm test' }), '跑 npm test')
  assert.equal(describeAction('web_fetch', { url: 'https://example.com/a/b' }), '查 example.com')
  assert.equal(describeAction('web_search', { queries: ['记忆插件 设计'] }), '搜 记忆插件 设计')
  assert.equal(describeAction('subagent', { description: '查资料' }), '派 查资料')
  assert.equal(describeAction('workflow', { meta: { name: 'audit' } }), '跑工作流 audit')
  assert.equal(describeAction('schedule_create', { title: '每周汇总' }), '排 每周汇总')
  // 只读 / 聊天类不算「干了什么」
  assert.equal(describeAction('read', { file_path: 'a.md' }), null)
  assert.equal(describeAction('persona_remember', {}), null)
  assert.equal(describeAction('some_unknown_tool', {}), null)
})

test('buffer 按会话攒动作，相邻重复只记一次', () => {
  const buffer = createWorklogBuffer({ ...WORKLOG })
  buffer.record('a', 'write', { file_path: 'x/one.js' })
  buffer.record('a', 'write', { file_path: 'x/one.js' })
  buffer.record('a', 'ops_bash', { command: 'npm test' })
  buffer.record('b', 'write', { file_path: 'y/two.js' })
  buffer.record('a', 'read', { file_path: 'x/one.js' })

  assert.deepEqual(buffer.peek('a'), ['改 one.js', '跑 npm test'])
  assert.deepEqual(buffer.take('a'), ['改 one.js', '跑 npm test'])
  assert.deepEqual(buffer.take('a'), [])
  assert.deepEqual(buffer.peek('b'), ['改 two.js'])
  buffer.clear()
  assert.deepEqual(buffer.peek('b'), [])
})

test('segment 有本地时间、超长时标出省略了几步', () => {
  const at = new Date(2026, 10, 23, 9, 5, 0).getTime()
  const text = buildWorklogSegment(['改 a.js', '跑 npm test'], at, WORKLOG)
  assert.match(text, /^- 09:05 改 a\.js；跑 npm test$/)

  const many = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 步`)
  const long = buildWorklogSegment(many, at, WORKLOG)
  assert.match(long, /等 20 步$/)
  assert.ok(!long.includes('第 1 步'))
  assert.ok(long.includes('第 20 步'))
})

test('mergeWorklog 追加多轮记录，超长只留最近的整行', () => {
  assert.equal(mergeWorklog('', '- 09:00 改 a.js'), '- 09:00 改 a.js')
  assert.equal(mergeWorklog('- 09:00 改 a.js', '- 10:00 跑测试'), '- 09:00 改 a.js\n- 10:00 跑测试')

  const existing = Array.from({ length: 60 }, (_, i) => `- 0${i % 10}:00 第 ${i} 步`).join('\n')
  const merged = mergeWorklog(existing, '- 11:00 最后一步', { ...WORKLOG, maxContentChars: 300, keepChars: 200 })
  assert.ok(merged.startsWith('…\n'))
  assert.ok(merged.includes('- 11:00 最后一步'))
  assert.ok(merged.length <= 300)
  // 裁剪后第一行必须是完整的一条，不要半截
  assert.match(merged.split('\n')[1], /^- \d\d:\d\d /)
})

test('worklogPath / worklogSlug 给出稳定的路径', () => {
  assert.equal(worklogSlug('Dsh-Leinao'), 'dsh-leinao')
  assert.equal(worklogSlug('我的 项目!!'), 'workspace')
  assert.equal(worklogSlug(''), 'workspace')

  const at = new Date(2026, 10, 23, 9, 5, 0).getTime()
  assert.equal(worklogPath('D:\\01_Code\\github\\dsh-leinao', at), 'worklog/2026-11-23/dsh-leinao')
  assert.equal(worklogPath('', at), 'worklog/2026-11-23/workspace')
})
