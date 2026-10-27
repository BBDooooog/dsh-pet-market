// Minimal, read-only ZIP reader: central directory walk + inflateRaw.
// Deliberately strict — the market only accepts what it can verify.

import { inflateRawSync } from 'node:zlib'
import { MarketError } from './util.js'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(buf) {
  const min = 22
  if (buf.length < min) return -1
  const start = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - min; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

export function isZip(buf) {
  return !!buf && buf.length > 4 && buf.readUInt32LE(0) === LOC_SIG
}

export function openZip(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new MarketError('zip-invalid', 'package is empty')
  const eocd = findEocd(buf)
  if (eocd === -1) throw new MarketError('zip-invalid', 'package is not a zip archive (no end-of-central-directory)')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset + cdSize > buf.length) throw new MarketError('zip-invalid', 'central directory points outside the archive')

  const entries = []
  let cursor = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buf.length) throw new MarketError('zip-invalid', 'truncated central directory')
    if (buf.readUInt32LE(cursor) !== CEN_SIG) throw new MarketError('zip-invalid', 'bad central directory record')
    const flags = buf.readUInt16LE(cursor + 8)
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const size = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const externalAttrs = buf.readUInt32LE(cursor + 38)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) throw new MarketError('zip-invalid', 'encrypted entries are not supported: ' + name)
    if (method !== 0 && method !== 8) throw new MarketError('zip-invalid', 'unsupported compression method ' + method + ' for ' + name)
    const unixMode = (externalAttrs >>> 16) & 0xffff
    const isSymlink = (unixMode & 0xf000) === 0xa000
    entries.push({ name, method, size, compressedSize, crc, localOffset, isSymlink })
  }
  return {
    entries,
    names: entries.map((entry) => entry.name),
    read(name) {
      const entry = entries.find((candidate) => candidate.name === name)
      if (!entry) return null
      return readEntry(buf, entry)
    },
  }
}

function readEntry(buf, entry) {
  const offset = entry.localOffset
  if (offset + 30 > buf.length) throw new MarketError('zip-invalid', 'truncated local header: ' + entry.name)
  if (buf.readUInt32LE(offset) !== LOC_SIG) throw new MarketError('zip-invalid', 'bad local header: ' + entry.name)
  const nameLen = buf.readUInt16LE(offset + 26)
  const extraLen = buf.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLen + extraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) throw new MarketError('zip-invalid', 'truncated entry data: ' + entry.name)
  const raw = buf.slice(dataStart, dataEnd)
  if (entry.method === 0) return Buffer.from(raw)
  let out
  try {
    out = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1024) * 4 + 1024 })
  } catch (err) {
    throw new MarketError('zip-invalid', 'deflate error in ' + entry.name + ': ' + (err && err.message ? err.message : err))
  }
  if (out.length !== entry.size) {
    throw new MarketError('zip-invalid', 'size mismatch in ' + entry.name + ' (' + out.length + ' != ' + entry.size + ')')
  }
  return out
}

// Path rules: no absolute paths, no drive letters, no `..`, no backslashes.
export function safeEntryName(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/')
  if (!text || text.endsWith('/')) return null
  if (text.indexOf('\0') !== -1) return null
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  const parts = []
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (!parts.length) return null
  return parts.join('/')
}

export function isIgnorableEntry(name) {
  const text = String(name || '')
  if (!text) return true
  if (text.endsWith('/')) return true
  if (text.startsWith('__MACOSX/')) return true
  const base = text.slice(text.lastIndexOf('/') + 1)
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini'
}

export const ZIP_LIMITS = {
  maxEntries: 512,
  maxUncompressed: 80 * 1024 * 1024,
  maxSingleEntry: 64 * 1024 * 1024,
  maxRatio: 200,
}

// Extracts everything into a { path: Buffer } map after enforcing the budget rules.
export function extractAll(zip, limits = ZIP_LIMITS) {
  if (zip.entries.length > limits.maxEntries) {
    throw new MarketError('zip-bomb', 'archive has ' + zip.entries.length + ' entries (limit ' + limits.maxEntries + ')')
  }
  const files = Object.create(null)
  let total = 0
  for (const entry of zip.entries) {
    if (isIgnorableEntry(entry.name)) continue
    if (entry.isSymlink) throw new MarketError('path-traversal', 'symbolic link entry: ' + entry.name)
    const clean = safeEntryName(entry.name)
    if (!clean) throw new MarketError('path-traversal', 'unsafe entry name: ' + entry.name)
    if (entry.size > limits.maxSingleEntry) {
      throw new MarketError('zip-bomb', 'entry too large: ' + entry.name)
    }
    const ratio = entry.compressedSize > 0 ? entry.size / entry.compressedSize : 0
    if (ratio > limits.maxRatio && entry.size > 1024 * 1024) {
      throw new MarketError('zip-bomb', 'suspicious compression ratio in ' + entry.name)
    }
    total += entry.size
    if (total > limits.maxUncompressed) {
      throw new MarketError('zip-bomb', 'archive expands beyond ' + limits.maxUncompressed + ' bytes')
    }
    const data = zip.read(entry.name)
    if (!data) continue
    files[clean] = data
  }
  return files
}

// A pack may ship its contents inside one top-level folder: strip it when every
// entry shares the same first segment.
export function stripCommonRoot(files) {
  const names = Object.keys(files)
  if (!names.length) return files
  const first = names[0].split('/')[0]
  if (!first) return files
  for (const name of names) {
    if (!name.startsWith(first + '/')) return files
  }
  const out = Object.create(null)
  for (const name of names) out[name.slice(first.length + 1)] = files[name]
  return out
}
