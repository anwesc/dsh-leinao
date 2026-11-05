/**
 * 设置页后端：白名单校验、原子写、HTTP 接口。
 * 这里不打真实 HTTP —— 直接拿到 register 的 handler，用假 req/res 跑一遍。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  EDITABLE,
  configSnapshot,
  flattenPatch,
  installSettingsApi,
  mergeIntoFile,
  pickEditable,
  restartKeys,
  sanitizePatch,
  writeConfigFile,
} from '../src/settings.js'

function tempFile(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-settings-'))
  const file = join(dir, 'leinao.json')
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial), 'utf8')
  return file
}

function fakeRequest({ method = 'GET', headers = {}, body } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = headers
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    queueMicrotask(() => {
      request.emit('data', Buffer.from(text))
      request.emit('end')
    })
  }
  return request
}

function fakeResponse() {
  const response = {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
    },
    end(text) {
      response.body = text
    },
    json() {
      return JSON.parse(response.body)
    },
  }
  return response
}

/** 造一个只认 inject(['webServer']) 的宿主上下文，返回拿到的路由。 */
function hostWithServer(deps) {
  const hosted = { route: null }
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['webServer'])
      callback({
        webServer: {
          register(route) {
            hosted.route = route
            return () => {
              hosted.route = null
            }
          },
        },
        effect(fn) {
          fn()
        },
      })
    },
  }
  installSettingsApi(ctx, deps)
  return hosted
}

test('settings: 白名单只放行认识的键，未知键明确报错', () => {
  const { entries, unknown } = flattenPatch({ mood: { halfLifeHours: 8 }, nope: 1, journal: { git: false } })
  assert.deepEqual(entries, [['mood.halfLifeHours', 8], ['journal.git', false]])
  assert.deepEqual(unknown, ['nope'])

  const bad = sanitizePatch({ nope: 1 })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /nope/)

  const empty = sanitizePatch({})
  assert.equal(empty.ok, false)
})

test('settings: 数字夹到区间、布尔/字符串校验类型', () => {
  const clamped = sanitizePatch({ memory: { indexMaxLines: 999 }, prompt: { maxChars: 1 } })
  assert.equal(clamped.ok, true)
  assert.equal(clamped.patch.memory.indexMaxLines, EDITABLE['memory.indexMaxLines'].max)
  assert.equal(clamped.patch.prompt.maxChars, EDITABLE['prompt.maxChars'].min)

  assert.equal(sanitizePatch({ enabled: 'yes' }).ok, false)
  const trimmed = sanitizePatch({ 'journal.remote': '  https://x/y.git  ' })
  assert.equal(trimmed.patch.journal.remote, 'https://x/y.git')
  assert.equal(sanitizePatch({ 'mood.halfLifeHours': 'abc' }).ok, false)
})

test('settings: 只写改动的键，默认值不落盘', () => {
  const file = tempFile({ journal: { push: true } })
  mergeIntoFile(file, { memory: { indexMaxLines: 5 } })
  mergeIntoFile(file, { journal: { push: false } })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved, { journal: { push: false }, memory: { indexMaxLines: 5 } })
})

test('settings: 快照只暴露白名单字段，重启项单独列', () => {
  const snapshot = configSnapshot({
    file: '/tmp/leinao.json',
    config: { enabled: true, dshHome: '/secret', seed: { name: 'x' }, mood: { halfLifeHours: 6 } },
    defaults: { enabled: true, dshHome: '/secret', mood: { halfLifeHours: 6 } },
    status: { turns: 3 },
    overridden: ['dshHome'],
  })
  assert.deepEqual(snapshot.config, { enabled: true, mood: { halfLifeHours: 6 } })
  assert.equal(snapshot.config.dshHome, undefined)
  assert.equal(snapshot.config.seed, undefined)
  assert.deepEqual(snapshot.status, { turns: 3 })
  assert.deepEqual(snapshot.overridden, ['dshHome'])
  assert.equal(snapshot.restart.includes('enabled'), true)
  assert.equal(snapshot.restart.includes('mood.halfLifeHours'), false)
  assert.equal(restartKeys().length > 0, true)
})

test('settings: GET 返回配置与状态，PUT 写盘并重载', async () => {
  const file = tempFile({ mood: { halfLifeHours: 6 } })
  const cfg = { enabled: true, mood: { halfLifeHours: 6 }, journal: { git: false, push: false } }
  let reloads = 0
  const hosted = hostWithServer({
    file,
    getConfig: () => cfg,
    getDefaults: () => ({ enabled: true, mood: { halfLifeHours: 6 }, journal: { git: false, push: false } }),
    reload: () => {
      reloads += 1
      Object.assign(cfg, JSON.parse(readFileSync(file, 'utf8')))
    },
    status: { phase: 'active', turns: 2 },
    overridden: [],
  })
  assert.equal(hosted.route.kind, 'exact')
  assert.equal(hosted.route.path, '/dsh-leinao/config')

  const getResponse = fakeResponse()
  await hosted.route.handler(fakeRequest({ headers: { host: '127.0.0.1:59091' } }), getResponse)
  assert.equal(getResponse.status, 200)
  const body = getResponse.json()
  assert.equal(body.file, file)
  assert.deepEqual(body.status, { phase: 'active', turns: 2 })
  assert.equal(body.config.mood.halfLifeHours, 6)
  assert.equal(body.defaults.mood.halfLifeHours, 6)

  const putResponse = fakeResponse()
  await hosted.route.handler(
    fakeRequest({ method: 'PUT', headers: { host: '127.0.0.1:59091' }, body: { mood: { halfLifeHours: 12 } } }),
    putResponse,
  )
  assert.equal(putResponse.status, 200)
  assert.equal(reloads, 1)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mood: { halfLifeHours: 12 } })
  assert.equal(putResponse.json().config.mood.halfLifeHours, 12)
})

test('settings: 坏 patch 400，跨源 403，写不进去', async () => {
  const file = tempFile({})
  const hosted = hostWithServer({
    file,
    getConfig: () => ({}),
    getDefaults: () => ({}),
    reload: () => {},
  })

  const bad = fakeResponse()
  await hosted.route.handler(fakeRequest({ method: 'PUT', headers: { host: '127.0.0.1:1' }, body: { unknown: 1 } }), bad)
  assert.equal(bad.status, 400)

  const cross = fakeResponse()
  await hosted.route.handler(
    fakeRequest({ method: 'GET', headers: { host: '127.0.0.1:1', origin: 'https://evil.example' } }),
    cross,
  )
  assert.equal(cross.status, 403)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
})

test('settings: 宿主没有 webServer 时安静地不挂路由', () => {
  const ctx = {
    inject(services, callback) {
      callback({})
    },
  }
  assert.equal(installSettingsApi(ctx, { file: null, getConfig: () => ({}), getDefaults: () => ({}) }), true)
  assert.equal(installSettingsApi({}, { file: null, getConfig: () => ({}), getDefaults: () => ({}) }), false)
})

test('settings: 写文件是原子的，目录里不留 tmp', () => {
  const file = tempFile()
  writeConfigFile(file, { a: 1 })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /\n$/)
  assert.deepEqual(pickEditable({ a: 1 }), {})
})
