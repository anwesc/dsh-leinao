import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { renderProfile, renderUserModel } from './render.js'
import { memoryStats } from './memory.js'
import { observationStats } from './observations.js'
import { personaPaths } from './store.js'
import { buildZip } from './zip.js'

/**
 * 导出内存成一包：给人拿走、也能原样导回（journal 在里面，重放即可重建）。
 * 只打包纯数据，不含配置里的密钥。
 */
export const EXPORT = {
  version: 1,
  /** 最多留几份历史导出，免得越攒越大 */
  keep: 10,
  dirName: 'exports',
}

/** 时间戳文件名：20261116-102600 */
export function exportStamp(nowMs) {
  const date = new Date(nowMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function walkFiles(root, base = root) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base))
    } else if (entry.isFile()) {
      out.push({ full, name: relative(base, full).split(sep).join('/') })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function textOf(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 组装这一包里的文件，测试里可以直接看清单 */
export function buildExportFiles(dataDir, state, nowMs, options = {}) {
  const paths = personaPaths(dataDir)
  const files = []

  // 状态不完整（比如刚建目录）时退回落盘文件，导出不该因此失败
  let profile
  try {
    profile = options.profile ?? renderProfile(state, nowMs, options)
  } catch {
    profile = textOf(paths.profile) ?? '# 还没有 PROFILE\n'
  }
  let userModel
  try {
    userModel = options.userModel ?? renderUserModel(state, nowMs, options)
  } catch {
    userModel = textOf(paths.userModel) ?? '# 还没有 USER\n'
  }
  files.push({ name: 'PROFILE.md', data: profile })
  files.push({ name: 'USER.md', data: userModel })

  const stateText = textOf(paths.state)
  if (stateText !== null) files.push({ name: 'state.json', data: stateText })

  const journal = walkFiles(paths.journal)
  for (const file of journal) files.push({ name: `journal/${file.name}`, data: readFileSync(file.full) })

  const stats = memoryStats(state, 'self')
  const observations = observationStats(state)
  const manifest = {
    version: EXPORT.version,
    exportedAt: new Date(nowMs).toISOString(),
    counts: {
      pages: stats.visible ?? 0,
      folded: stats.folded ?? 0,
      observations: observations.count ?? 0,
      events: state?.stats?.events ?? journal.reduce((sum, file) => sum + countLines(file.full), 0),
      turns: state?.stats?.userTurns ?? 0,
    },
    files: files.map((file) => file.name).concat('manifest.json').sort(),
    note: 'journal 是事件流，按顺序重放即可重建 state.json、PROFILE.md 与 USER.md。',
  }
  files.unshift({ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` })

  return { files, manifest }
}

function countLines(file) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** 写一份 zip，返回路径；顺手清掉太旧的导出 */
export function writeExportZip(dataDir, state, nowMs = Date.now(), options = {}) {
  const paths = personaPaths(dataDir)
  const dir = join(paths.view, EXPORT.dirName)
  mkdirSync(dir, { recursive: true })

  const { files, manifest } = buildExportFiles(dataDir, state, nowMs, options)
  const buffer = buildZip(files, new Date(nowMs))
  const file = join(dir, `leinao-${exportStamp(nowMs)}.zip`)
  writeFileSync(file, buffer)

  pruneExports(dir, Number(options.keep ?? EXPORT.keep))
  return { path: file, bytes: buffer.length, manifest }
}

function pruneExports(dir, keep) {
  const limit = Number.isFinite(keep) ? Math.max(1, keep) : EXPORT.keep
  let files = []
  try {
    files = readdirSync(dir)
      .filter((name) => /^leinao-.*\.zip$/.test(name))
      .map((name) => ({ name, at: safeMtime(join(dir, name)) }))
      .sort((a, b) => b.at - a.at)
  } catch {
    return
  }
  for (const file of files.slice(limit)) {
    try {
      unlinkSync(join(dir, file.name))
    } catch {
      /* 删不掉就算了，下次再来 */
    }
  }
}

function safeMtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}
