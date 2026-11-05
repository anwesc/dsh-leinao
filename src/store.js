/**
 * 落盘：state.json 是**缓存**，不是真源。
 * 读的时候先看缓存戳（journal 条数 + 最后一条 id）对不对得上；对不上就重放。
 * 写一律 tmp → rename，断电最多丢一次，不会留半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { localIso, scanEvents } from './journal.js'
import { fold, STATE_VERSION } from './replay.js'

export function personaPaths(dataDir) {
  return {
    root: dataDir,
    journal: join(dataDir, 'journal'),
    view: join(dataDir, 'view'),
    profile: join(dataDir, 'view', 'PROFILE.md'),
    state: join(dataDir, 'state.json'),
    device: join(dataDir, 'device.json'),
  }
}

export function ensureDirs(dataDir) {
  for (const dir of [dataDir, join(dataDir, 'journal'), join(dataDir, 'view')]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** 原子写：同目录 tmp → rename（跨盘 rename 会失败，所以 tmp 必须同目录） */
export function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 清不动就算了，别掩盖原始错误
    }
    throw error
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8').trim()
    if (!text) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function cacheStamp(state) {
  return state?.meta?.journal ?? null
}

function stampOf(scan) {
  const last = scan.events[scan.events.length - 1]
  return { count: scan.events.length, lastId: last?.id ?? null, lastAt: last?.at ?? null }
}

function sameStamp(a, b) {
  return Boolean(a && b && a.count === b.count && a.lastId === b.lastId && a.lastAt === b.lastAt)
}

/**
 * 读当前状态。
 * @returns {{state:object, diagnostics:object, scan:object, cached:boolean, rebuilt:boolean}}
 */
export function loadState(dataDir, { forceRebuild = false } = {}) {
  const paths = personaPaths(dataDir)
  const scan = scanEvents(dataDir)
  const stamp = stampOf(scan)

  if (!forceRebuild) {
    const cached = readJson(paths.state, null)
    if (cached && cached.version === STATE_VERSION && sameStamp(cacheStamp(cached), stamp) && stamp.count > 0) {
      return { state: cached.state, diagnostics: { applied: stamp.count, skipped: 0, skippedKinds: {} }, scan, cached: true, rebuilt: false }
    }
  }

  const { state, diagnostics } = fold(scan.events)
  return { state, diagnostics, scan, cached: false, rebuilt: true }
}

export function saveState(dataDir, state, scan) {
  const paths = personaPaths(dataDir)
  const payload = {
    version: STATE_VERSION,
    meta: {
      journal: stampOf(scan ?? { events: [] }),
      updatedAt: localIso(),
    },
    state,
  }
  writeJsonAtomic(paths.state, payload)
  return payload
}

/** 供 git 层判断"journal 有没有变" */
export function journalMtime(dataDir) {
  const dir = join(dataDir, 'journal')
  try {
    return existsSync(dir) ? statSync(dir).mtimeMs : 0
  } catch {
    return 0
  }
}
