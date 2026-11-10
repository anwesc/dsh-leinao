/**
 * 设置页的后端：读写 $DSH_HOME/leinao.json，并给客户端一个同源 JSON 接口。
 *
 * 约定与 qqbot-guard 一致：
 * - 路由 `GET/PUT /dsh-leinao/config`，只接受本机回环来源；
 * - GET 返回「生效中的配置 + 默认值 + 运行状态 + 哪些键要重启」；
 * - PUT 只接受白名单里的键，写进配置文件后立刻热重载（重启才生效的键会在 UI 上标出来）。
 *
 * 为什么不让客户端直接读文件：客户端跑在浏览器里，没有 fs；而且写配置要原子、
 * 要校验类型，放在宿主侧做一次比在 UI 里散着做可靠。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 可配项白名单：类型、范围、（是否）重启生效。没列在这里的键，设置页改不了。 */
export const EDITABLE = {
  enabled: { type: 'boolean', restart: true },
  dataDir: { type: 'string', maxLength: 400, restart: true },
  deviceId: { type: 'string', maxLength: 80, restart: true },
  debug: { type: 'boolean' },
  'journal.git': { type: 'boolean', restart: true },
  'journal.push': { type: 'boolean' },
  'journal.remote': { type: 'string', maxLength: 400 },
  'journal.pullTimeoutMs': { type: 'number', min: 1000, max: 300_000 },
  'journal.commitDebounceMs': { type: 'number', min: 0, max: 120_000 },
  'journal.pushDebounceMs': { type: 'number', min: 0, max: 3_600_000 },
  'mood.debounceMs': { type: 'number', min: 0, max: 120_000 },
  'mood.halfLifeHours': { type: 'number', min: 1, max: 72 },
  'prompt.order': { type: 'number', min: 0, max: 1000, restart: true },
  'prompt.maxChars': { type: 'number', min: 200, max: 8000 },
  'prompt.userOrder': { type: 'number', min: 0, max: 1000, restart: true },
  'prompt.userMaxChars': { type: 'number', min: 0, max: 4000 },
  'memory.halfLifeDays': { type: 'number', min: 1, max: 365 },
  'memory.indexMaxLines': { type: 'number', min: 1, max: 20 },
  'memory.indexMaxChars': { type: 'number', min: 40, max: 4000 },
  'memory.strongThreshold': { type: 'number', min: 0.05, max: 1 },
  'memory.hideBelow': { type: 'number', min: 0, max: 0.99 },
  'memory.foldAfterDays': { type: 'number', min: 0, max: 3650 },
  'memory.foldBelowStrength': { type: 'number', min: 0.05, max: 1 },
  'memory.foldMinGroup': { type: 'number', min: 2, max: 50 },
  'memory.foldEveryTurns': { type: 'number', min: 0, max: 1000 },
  'memory.foldMaxPrompts': { type: 'number', min: 0, max: 100 },
  'memory.weakRecallHours': { type: 'number', min: 0, max: 720 },
}

const CONFIG_PATH = '/dsh-leinao/config'
const BODY_LIMIT_BYTES = 64 * 1024
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function restartKeys() {
  return Object.entries(EDITABLE)
    .filter(([, rule]) => rule.restart)
    .map(([key]) => key)
}

/** 默认值与当前值都只挑白名单里的键，避免把内部字段（seed/dshHome）漏给 UI。 */
export function pickEditable(config = {}) {
  const out = {}
  for (const key of Object.keys(EDITABLE)) {
    const value = readPath(config, key)
    if (value !== undefined) writePath(out, key, value)
  }
  return out
}

function readPath(object, path) {
  let cursor = object
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

function writePath(object, path, value) {
  const parts = path.split('.')
  let cursor = object
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
  return object
}

/** 把客户端发来的嵌套 patch 摊平成 [key, value]，未知键直接拒绝（比静默丢弃好排查）。 */
export function flattenPatch(patch, prefix = '', out = [], unknown = []) {
  if (!isPlain(patch)) return { entries: out, unknown }
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlain(value)) {
      flattenPatch(value, path, out, unknown)
    } else if (EDITABLE[path]) {
      out.push([path, value])
    } else {
      unknown.push(path)
    }
  }
  return { entries: out, unknown }
}

/** 类型与范围校验；数字会被夹到区间里（UI 的 min/max 只是第一道防线）。 */
export function sanitizePatch(patch) {
  const { entries, unknown } = flattenPatch(patch)
  if (unknown.length) return { ok: false, error: `不认识的配置项：${unknown.join('、')}` }
  if (!entries.length) return { ok: false, error: '没有可保存的改动' }
  const nested = {}
  for (const [key, raw] of entries) {
    const rule = EDITABLE[key]
    if (rule.type === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, error: `${key} 需要 true / false` }
      writePath(nested, key, raw)
      continue
    }
    if (rule.type === 'string') {
      if (typeof raw !== 'string') return { ok: false, error: `${key} 需要字符串` }
      const value = raw.trim()
      if (value.length > (rule.maxLength ?? 400)) return { ok: false, error: `${key} 太长` }
      writePath(nested, key, value)
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) return { ok: false, error: `${key} 需要数字` }
    writePath(nested, key, Math.min(rule.max, Math.max(rule.min, value)))
  }
  return { ok: true, patch: nested }
}

export function readConfigFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return isPlain(parsed) ? parsed : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`读取配置失败：${error.message}`)
  }
}

export function writeConfigFile(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const tmp = join(dirname(file), `.persona.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 文件里只追加 patch，不把默认值写进去——以后改默认值，没动过的键还能跟着变。 */
export function mergeIntoFile(file, patch) {
  const current = readConfigFile(file)
  const merged = deepMerge(current, patch)
  writeConfigFile(file, merged)
  return merged
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlain(value) && isPlain(base?.[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function readBody(request, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function loopbackAuthority(hostHeader) {
  const host = String(hostHeader ?? '').toLowerCase()
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  return host.split(':')[0]
}

/** 只信本机回环：DSH 的桌面/网页壳都从 127.0.0.1 发请求。 */
export function isSameOrigin(request) {
  try {
    const origin = request?.headers?.origin
    const hostHeader = request?.headers?.host ?? ''
    if (!origin) return true
    const url = new URL(origin)
    if (url.protocol === 'dsh-app:') return true
    return loopbackAuthority(url.host) === loopbackAuthority(hostHeader)
  } catch {
    return false
  }
}

export function configSnapshot({ file, config, defaults, status = {}, overridden = [] }) {
  return {
    file,
    config: pickEditable(config),
    defaults: pickEditable(defaults),
    restart: restartKeys(),
    overridden,
    status,
  }
}

/**
 * 注册设置页接口。`reload()` 在写盘后调用，把新配置合进运行中的 cfg。
 * @returns {boolean} 宿主有没有注入能力
 */
export function installSettingsApi(ctx, { file, getConfig, getDefaults, reload, status, overridden, log } = {}) {
  if (typeof ctx?.inject !== 'function') return false
  const snapshot = () => configSnapshot({
    file,
    config: getConfig(),
    defaults: getDefaults(),
    status: typeof status === 'function' ? status() : status,
    overridden: typeof overridden === 'function' ? overridden() : overridden,
  })

  const handle = async (request, response) => {
    if (!isSameOrigin(request)) return sendJson(response, 403, { error: '来源不被信任（只允许本机）' })
    const method = String(request?.method ?? 'GET').toUpperCase()
    try {
      if (method === 'GET') return sendJson(response, 200, snapshot())
      if (method === 'PUT' || method === 'POST') {
        if (!file) return sendJson(response, 400, { error: '没有可写的配置文件' })
        const parsed = JSON.parse(await readBody(request))
        const checked = sanitizePatch(parsed)
        if (!checked.ok) return sendJson(response, 400, { error: checked.error })
        mergeIntoFile(file, checked.patch)
        reload?.()
        log?.info?.(`[leinao] 设置页已保存：${file}`)
        return sendJson(response, 200, snapshot())
      }
      return sendJson(response, 405, { error: '不支持的方法' })
    } catch (error) {
      log?.warn?.(`[leinao] 配置请求失败：${error.message}`)
      return sendJson(response, 400, { error: String(error?.message ?? error) })
    }
  }

  ctx.inject(['webServer'], (host) => {
    const server = host?.webServer
    if (!server || typeof server.register !== 'function') {
      log?.warn?.('[leinao] webServer 不可用，设置页接口没挂上')
      return
    }
    const mount = () => {
      const dispose = server.register({ kind: 'exact', path: CONFIG_PATH, handler: handle })
      return () => {
        try {
          dispose?.()
        } catch {
          /* 宿主卸载时路由可能已经没了 */
        }
      }
    }
    if (typeof host.effect === 'function') host.effect(mount, 'leinao: settings api')
    else mount()
  })
  return true
}

export { CONFIG_PATH as SETTINGS_PATH }
