/**
 * 设备 id：每台机器只写自己的 journal 子目录，跨端 rebase 才不会撞车。
 *
 * 生成规则：<主机名净化>-<4位随机>，例如 pc-anwen-a1b2。
 * 存 $DSH_HOME/persona/device.json，不进 git 仓库——克隆出去的机器必须拿到新 id。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'

const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

export function sanitizeHost(name) {
  return String(name || 'device')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'device'
}

export function newDeviceId(host = hostname()) {
  return `${sanitizeHost(host)}-${randomBytes(2).toString('hex')}`
}

export function isValidDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID_RE.test(id)
}

/** 读取或创建 device.json；已有的 id 永远不改（改了等于换设备身份）。 */
export function ensureDeviceId(stateDir, { host = hostname(), override = '' } = {}) {
  if (override) {
    if (!isValidDeviceId(override)) throw new Error(`deviceId 不合法：${override}`)
    return override
  }
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'device.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (isValidDeviceId(parsed?.id)) return parsed.id
    } catch {
      // 文件损坏 → 重新生成（旧的 journal 子目录还在，不会丢数据）
    }
  }
  const id = newDeviceId(host)
  writeFileSync(file, `${JSON.stringify({ id, host, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return id
}
