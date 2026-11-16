import { deflateRawSync } from 'node:zlib'

/**
 * 最小 ZIP 打包器：只用 node:zlib，不引第三方依赖。
 * 只做「写」——类脑导出记忆用，不需要读回。
 */

export const ZIP = {
  version: 20,
  /** 文件名按 UTF-8 解释（中文路径要这个位） */
  flagUtf8: 0x0800,
  /** 压缩后反而更大就退回 store，避免小文件膨胀 */
  storeMethod: 0,
  deflateMethod: 8,
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/** 标准 CRC-32，和 ZIP 里记的是同一个 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 把 Date 换成 ZIP 的 DOS 时间/日期 */
export function dosTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function asBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8')
}

/**
 * 打包成 ZIP。
 * entries: [{ name, data }]，name 用 / 分隔；重复名字后者覆盖前者。
 */
export function buildZip(entries, now = new Date()) {
  const { time, date } = dosTime(now)
  const seen = new Map()
  for (const entry of entries ?? []) {
    const name = String(entry?.name ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name) continue
    seen.set(name, asBuffer(entry?.data))
  }

  const locals = []
  const centrals = []
  let offset = 0

  for (const [name, raw] of seen) {
    const nameBytes = Buffer.from(name, 'utf8')
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? ZIP.deflateMethod : ZIP.storeMethod
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(ZIP.version, 4)
    local.writeUInt16LE(ZIP.flagUtf8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(ZIP.version, 4)
    central.writeUInt16LE(ZIP.version, 6)
    central.writeUInt16LE(ZIP.flagUtf8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralStart = offset
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(seen.size, 8)
  end.writeUInt16LE(seen.size, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuffer, end])
}
