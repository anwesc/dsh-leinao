import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionGate } from '../src/sessions.js'

const DAY = 86400000
const NOW = Date.parse('2026-11-10T12:00:00+08:00')

function withDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-sessions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'leinao-sessions.json')
}

test('SessionGate：默认不覆盖；设了 off 只影响这个会话，clear 能回到默认', (t) => {
  const path = withDir(t)
  const gate = new SessionGate({ path, ttlDays: 7, now: () => NOW })

  assert.equal(gate.getOverride('s1'), undefined)
  assert.equal(gate.proactiveEnabled('s1'), true)

  assert.equal(gate.setOverride('s1', false), true)
  assert.equal(gate.getOverride('s1'), false)
  assert.equal(gate.proactiveEnabled('s1'), false)
  assert.equal(gate.proactiveEnabled('s2'), true, '别的会话不受影响')

  // 落盘后新实例还能读到
  const reopened = new SessionGate({ path, ttlDays: 7, now: () => NOW })
  assert.equal(reopened.getOverride('s1'), false)

  assert.equal(gate.clearOverride('s1'), true)
  assert.equal(gate.getOverride('s1'), undefined)
})

test('SessionGate：全局关掉时，会话 override 说了不算', (t) => {
  const path = withDir(t)
  const gate = new SessionGate({ path, ttlDays: 7, now: () => NOW })
  gate.setOverride('s1', true)
  assert.equal(gate.proactiveEnabled('s1', false), false)
  assert.equal(gate.describe('s1', false).effective, false)
  assert.equal(gate.describe('s1', true).effective, true)
})

test('SessionGate：过期条目在加载时清掉，坏文件当空处理', (t) => {
  const path = withDir(t)
  const old = new Date(NOW - 30 * DAY).toISOString()
  const fresh = new Date(NOW - 1 * DAY).toISOString()
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      sessions: {
        old: { proactive: false, at: old },
        fresh: { proactive: false, at: fresh },
        broken: { proactive: 'yes' },
      },
    }),
    'utf8',
  )
  const gate = new SessionGate({ path, ttlDays: 7, now: () => NOW })
  assert.equal(gate.getOverride('old'), undefined)
  assert.equal(gate.getOverride('fresh'), false)
  assert.equal(gate.getOverride('broken'), undefined, '类型不对的条目不算数')

  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(Object.keys(saved.sessions), ['fresh'])

  writeFileSync(path, '{ not json', 'utf8')
  const broken = new SessionGate({ path, ttlDays: 7, now: () => NOW })
  assert.equal(broken.getOverride('fresh'), undefined)
  assert.equal(broken.proactiveEnabled('any'), true)
})

test('SessionGate：没有文件时写入会建目录，路径为空时安静地不写', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-sessions-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'leinao-sessions.json')
  const gate = new SessionGate({ path, ttlDays: 0, now: () => NOW })
  assert.equal(gate.setOverride('s1', true), true)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessions.s1.proactive, true)

  const noFile = new SessionGate({ path: '', ttlDays: 7, now: () => NOW })
  assert.equal(noFile.setOverride('s1', true), false)
  assert.equal(noFile.getOverride('s1'), true, '内存里仍然记着，只是不落盘')
})

test('SessionGate：工作区默认关只影响这个目录，会话覆盖仍优先', (t) => {
  const path = withDir(t)
  const gate = new SessionGate({ path, ttlDays: 7, now: () => NOW })

  assert.equal(gate.getWorkspaceDisabled('/work/a'), false)
  assert.equal(gate.proactiveEnabled('s1', true, '/work/a'), true)

  assert.equal(gate.setWorkspace('/work/a', true), true)
  assert.equal(gate.getWorkspaceDisabled('/work/a'), true)
  assert.equal(gate.getWorkspaceDisabled('/work/b'), false)
  assert.equal(gate.proactiveEnabled('s1', true, '/work/a'), false)

  // 会话显式开，能压过工作区默认关
  gate.setOverride('s1', true)
  assert.equal(gate.proactiveEnabled('s1', true, '/work/a'), true)
  // 但全局关仍然一票否决
  assert.equal(gate.proactiveEnabled('s1', false, '/work/a'), false)

  // 工作区条目是长期偏好，不参与 TTL；重开后仍在
  const reopened = new SessionGate({ path, ttlDays: 7, now: () => NOW + 60 * DAY })
  assert.equal(reopened.getWorkspaceDisabled('/work/a'), true)
  assert.equal(reopened.getOverride('s1'), undefined, '会话条目过期被清掉')

  // 目录为空时说不清是哪个工作区
  assert.equal(gate.setWorkspace('', true), false)
  assert.equal(gate.describe('s1', true, '/work/a').workspaceDisabled, true)
})
