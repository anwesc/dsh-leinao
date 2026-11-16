import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { buildZip, crc32 } from '../src/zip.js'
import { buildExportFiles, exportStamp, writeExportZip } from '../src/bundle.js'
import { fold } from '../src/replay.js'
import { scanEvents } from '../src/journal.js'

/** 极简 zip 读取器：够测试用，只读 central directory */
function unzip(buffer) {
  const end = buffer.length - 22
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, 'EOCD 标记')
  const count = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const files = []
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'central 头')
    const method = buffer.readUInt16LE(offset + 10)
    const crc = buffer.readUInt32LE(offset + 16)
    const size = buffer.readUInt32LE(offset + 20)
    const nameLen = buffer.readUInt16LE(offset + 28)
    const extraLen = buffer.readUInt16LE(offset + 30)
    const commentLen = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const body = buffer.subarray(start, start + size)
    const data = method === 0 ? body : inflateRawSync(body)
    assert.equal(crc32(data), crc, `${name} 的 CRC 对得上`)
    files.push({ name, data })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return files
}

test('zip：能打包、能读回，中文文件名不坏', () => {
  const text = '类脑导出：记忆与观察\n'.repeat(50)
  const buffer = buildZip([
    { name: 'PROFILE.md', data: text },
    { name: 'journal/desktop/2026-11-16.jsonl', data: '{"kind":"page"}\n' },
    { name: 'empty.txt', data: '' },
  ])
  const files = unzip(buffer)
  assert.deepEqual(files.map((file) => file.name).sort(), ['PROFILE.md', 'empty.txt', 'journal/desktop/2026-11-16.jsonl'])
  assert.equal(files.find((file) => file.name === 'PROFILE.md').data.toString('utf8'), text)
  assert.equal(files.find((file) => file.name === 'empty.txt').data.length, 0)
})

test('zip：重名后者覆盖，空名字丢掉', () => {
  const files = unzip(buildZip([
    { name: 'a.txt', data: 'first' },
    { name: 'a.txt', data: 'second' },
    { name: '', data: 'ignored' },
  ]))
  assert.equal(files.length, 1)
  assert.equal(files[0].data.toString('utf8'), 'second')
})

test('export：清单里有 PROFILE/USER/manifest，journal 原样带上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-bundle-'))
  const device = join(dir, 'journal', 'desktop')
  mkdirSync(device, { recursive: true })
  writeFileSync(join(device, '2026-11-16.jsonl'), '{"kind":"seed"}\n')
  writeFileSync(join(dir, 'state.json'), '{"version":2}\n')
  const state = { pages: { 'people/laoda': { path: 'people/laoda', title: '老大', content: 'x', tags: [], updatedAt: '2026-11-16T00:00:00.000Z' } }, observations: {}, stats: { events: 1, userTurns: 2 } }

  const stamp = exportStamp(Date.parse('2026-11-16T10:26:00+08:00'))
  assert.equal(stamp, '20261116-102600')

  const { files, manifest } = buildExportFiles(dir, state, Date.parse('2026-11-16T02:26:00Z'))
  const names = files.map((file) => file.name)
  assert.ok(names.includes('manifest.json'))
  assert.ok(names.includes('PROFILE.md'))
  assert.ok(names.includes('USER.md'))
  assert.ok(names.includes('state.json'))
  assert.ok(names.includes('journal/desktop/2026-11-16.jsonl'))
  assert.equal(manifest.counts.pages, 1)
  assert.deepEqual(manifest.files, [...names].sort())
})

test('export：写出的 zip 能读回，且旧包会被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-bundle-write-'))
  mkdirSync(join(dir, 'journal', 'desktop'), { recursive: true })
  writeFileSync(join(dir, 'journal', 'desktop', '2026-11-16.jsonl'), '{"kind":"seed"}\n')
  const state = { pages: {}, observations: {}, stats: { events: 1, userTurns: 0 } }

  const written = []
  for (let i = 0; i < 3; i += 1) {
    written.push(writeExportZip(dir, state, Date.parse('2026-11-16T02:26:00Z') + i * 1000, { keep: 2 }))
  }
  const files = unzip(readFileSync(written[2].path))
  assert.ok(files.some((file) => file.name === 'manifest.json'))
  const exported = files.find((file) => file.name === 'manifest.json')
  assert.equal(JSON.parse(exported.data.toString('utf8')).version, 1)

  assert.equal(readdirSync(join(dir, 'view', 'exports')).length, 2, '只留 keep 份')
})

test('export：journal 重放后能重建同一份 state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leinao-bundle-replay-'))
  const device = join(dir, 'journal', 'desktop')
  mkdirSync(device, { recursive: true })
  const events = [
    { id: 'a', at: '2026-11-16T00:00:00.000Z', kind: 'page', path: 'people/laoda', title: '老大', content: '今天加班' },
    { id: 'b', at: '2026-11-16T00:01:00.000Z', kind: 'observation', key: '作息', value: '常熬夜', evidence: '又两点睡' },
  ]
  writeFileSync(join(device, '2026-11-16.jsonl'), events.map((event) => `${JSON.stringify(event)}\n`).join(''))
  const { files } = buildExportFiles(dir, { pages: {}, observations: {}, stats: {} }, Date.now())
  const journal = files.find((file) => file.name.endsWith('.jsonl'))
  writeFileSync(join(device, '2026-11-16.jsonl'), journal.data)
  const rebuilt = fold(scanEvents(dir).events).state
  assert.equal(rebuilt.pages['people/laoda'].title, '老大')
  assert.equal(rebuilt.observations['作息'].value, '常熬夜')
})
