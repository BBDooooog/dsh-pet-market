// Shared packaging helpers for the demo packs: walk a directory, inject
// checksums.json, validate with the market's own validator, emit a .dsppet.
// No dependencies, no network.

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { validatePack } from '../lib/pack.js'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

export function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, base, out)
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  // Fixed timestamp: a rebuild of unchanged sources must produce the same
  // bytes, otherwise every release ships a new sha256 for the same pack and
  // the digest chain (release asset digest → ledger → install) breaks.
  const stamp = dosTime(new Date(Date.UTC(2020, 0, 1, 0, 0, 0)))

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const deflated = deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const body = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, body)

    const dirEntry = Buffer.alloc(46)
    dirEntry.writeUInt32LE(0x02014b50, 0)
    dirEntry.writeUInt16LE(20, 4)
    dirEntry.writeUInt16LE(20, 6)
    dirEntry.writeUInt16LE(0x0800, 8)
    dirEntry.writeUInt16LE(method, 10)
    dirEntry.writeUInt16LE(stamp.time, 12)
    dirEntry.writeUInt16LE(stamp.day, 14)
    dirEntry.writeUInt32LE(crc, 16)
    dirEntry.writeUInt32LE(body.length, 20)
    dirEntry.writeUInt32LE(data.length, 24)
    dirEntry.writeUInt16LE(name.length, 28)
    dirEntry.writeUInt16LE(0, 30)
    dirEntry.writeUInt16LE(0, 32)
    dirEntry.writeUInt16LE(0, 34)
    dirEntry.writeUInt16LE(0, 36)
    dirEntry.writeUInt32LE(0, 38)
    dirEntry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([dirEntry, name]))

    offset += local.length + name.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

export function buildPack(srcDir, outDir) {
  const manifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'))
  const names = walk(srcDir).filter((name) => name !== 'checksums.json')

  const files = {}
  for (const name of names) files[name] = readFileSync(join(srcDir, name))

  const checksums = {}
  for (const name of names) checksums[name] = createHash('sha256').update(files[name]).digest('hex')
  files['checksums.json'] = Buffer.from(JSON.stringify({ schema: 1, files: checksums }, null, 2) + '\n', 'utf8')

  const descriptor = validatePack({ files })
  const zip = buildZip(Object.keys(files).sort().map((name) => ({ name, data: files[name] })))

  mkdirSync(outDir, { recursive: true })
  const base = manifest.petId + '-' + manifest.version
  const target = join(outDir, base + '.dsppet')
  writeFileSync(target, zip)
  const digest = createHash('sha256').update(zip).digest('hex')
  writeFileSync(target + '.sha256', digest + '  ' + base + '.dsppet\n', 'utf8')

  return {
    target,
    bytes: zip.length,
    sha256: digest,
    petId: descriptor.petId,
    version: descriptor.version,
    name: descriptor.name,
    animations: Object.keys(descriptor.renderer.animations),
    warnings: descriptor.warnings,
  }
}
