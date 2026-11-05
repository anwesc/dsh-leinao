/**
 * journal：append-only 事件流，按设备分目录。
 *
 *   <dataDir>/journal/<deviceId>/2026-11.jsonl
 *
 * 每台设备只写自己的子目录 → git 层面两个设备的改动永不重叠，pull --rebase 是纯追加。
 * 读 = 扫全部设备目录 → 按 id 去重 → 按 (at, id) 排序 → 交给 replay 重放。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/** 本地时区的 ISO 字符串（带 +08:00 这种偏移，别用 toISOString 丢了时区） */
export function localIso(date = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const offset = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
}

export function localMonth(date = new Date()) {
  return localIso(date).slice(0, 7)
}

/**
 * 事件 id 必须**单调可排序**：fold 按 (at, id) 排序，而 at 只到秒。
 * 同一秒内连写两条（seed 后紧跟 reset 就是这种情况）时，如果 id 只靠随机后缀，
 * 排序结果就是随机的 —— reset 会被排到 seed 前面，然后被 seed 覆盖回去。
 * 所以 id 里带毫秒 + 进程内自增序号，同毫秒也不会乱序。
 */
let eventSeq = 0

export function newEventId(deviceId, date = new Date()) {
  const base = localIso(date).slice(0, 19).replace(/[-:]/g, '')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  eventSeq = (eventSeq + 1) % 1000
  const seq = String(eventSeq).padStart(3, '0')
  return `${deviceId}-${base}${ms}-${seq}-${randomBytes(2).toString('hex')}`
}

/** 统一信封：{id, at, kind} + 各自载荷 */
export function makeEvent(kind, deviceId, payload = {}, date = new Date()) {
  return { id: newEventId(deviceId, date), at: localIso(date), kind, ...payload }
}

export function journalDir(dataDir) {
  return join(dataDir, 'journal')
}

export function journalFile(dataDir, deviceId, date = new Date()) {
  return join(journalDir(dataDir), deviceId, `${localMonth(date)}.jsonl`)
}

/** 追加一条事件；返回写入的文件路径。失败直接抛——写不进去就是写不进去，不装作成功。 */
export function appendEvent(dataDir, deviceId, event) {
  const file = journalFile(dataDir, deviceId, new Date(event.at))
  mkdirSync(join(dataDir, 'journal', deviceId), { recursive: true })
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  return file
}

function listJournalFiles(dataDir) {
  const root = journalDir(dataDir)
  if (!existsSync(root)) return []
  const files = []
  for (const device of readdirSync(root, { withFileTypes: true })) {
    if (!device.isDirectory() || device.name.startsWith('.')) continue
    const dir = join(root, device.name)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const file = join(dir, entry.name)
      try {
        if (statSync(file).isFile()) files.push(file)
      } catch {
        // 并发删除：忽略
      }
    }
  }
  return files.sort()
}

/**
 * 扫描全部事件。
 * - 坏行（半行、被截断）跳过并计数，不阻塞重放；
 * - 同 id 只留第一条（正常不会重复，重复说明同一事件被抄了两份）。
 */
export function scanEvents(dataDir) {
  const byId = new Map()
  const stats = { files: 0, lines: 0, bad: 0 }
  for (const file of listJournalFiles(dataDir)) {
    stats.files += 1
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      stats.lines += 1
      let event
      try {
        event = JSON.parse(line)
      } catch {
        stats.bad += 1
        continue
      }
      if (!event || typeof event.id !== 'string' || typeof event.kind !== 'string' || typeof event.at !== 'string') {
        stats.bad += 1
        continue
      }
      if (Number.isNaN(Date.parse(event.at))) {
        stats.bad += 1
        continue
      }
      if (!byId.has(event.id)) byId.set(event.id, event)
    }
  }
  const events = [...byId.values()].sort((a, b) => {
    const diff = Date.parse(a.at) - Date.parse(b.at)
    return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return { events, stats }
}
