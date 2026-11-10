/**
 * 落盘：state.json 是**缓存**，不是真源。
 * 读的时候先看缓存戳（journal 条数 + 最后一条 id）对不对得上；对不上就重放。
 * 写一律 tmp → rename，断电最多丢一次，不会留半截 JSON。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
    /** 用户模型单独一份，可以直接拷走 */
    userModel: join(dataDir, 'view', 'USER.md'),
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

/**
 * journal 的廉价指纹：目录里每个 jsonl 的 名字 + 大小 + mtime。
 * 用来判断"外部有没有写过"（git pull、别的进程），比逐行扫描便宜得多；
 * 自己 append 之后也会刷新它，避免下一轮又全量扫一遍。
 */
export function journalFingerprint(dataDir) {
  const root = journalDir(dataDir)
  const parts = []
  try {
    if (!existsSync(root)) return ''
    for (const device of readdirSync(root, { withFileTypes: true })) {
      if (!device.isDirectory() || device.name.startsWith('.')) continue
      const dir = join(root, device.name)
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        try {
          const info = statSync(join(dir, entry.name))
          parts.push(`${device.name}/${entry.name}:${info.size}:${info.mtimeMs}`)
        } catch {
          // 并发删除：忽略
        }
      }
    }
  } catch {
    return ''
  }
  return parts.sort().join('|')
}

function journalDir(dataDir) {
  return join(dataDir, 'journal')
}
