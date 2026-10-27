// Filesystem-backed state: config.json, ledger.json, installed pack directories,
// a download cache and a log file. Every write goes through a temp file + rename
// so a crash never leaves half-written JSON behind.

import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { MarketError, isObject, nowIso } from './util.js'

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  dataRoot: null,
  sources: [],
  catalogUrl: null,
  autoUpdate: false,
  keepVersions: 1,
  allowPrerelease: false,
}

export const DEFAULT_LEDGER = { schemaVersion: 1, packs: {} }

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(text)
    return isObject(value) ? value : fallback
  } catch {
    return fallback
  }
}

function writeJsonAtomic(path, value) {
  ensureDir(dirname(path))
  const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    try {
      writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
      rmSync(tmp, { force: true })
    } catch {
      throw new MarketError('disk-error', 'cannot write ' + path + ': ' + (err && err.message ? err.message : err))
    }
  }
}

export function defaultDataRoot() {
  return join(homedir(), '.dsh', 'petmarket')
}

export function openStore(options = {}) {
  const root = resolve(options.dataRoot || defaultDataRoot())
  const store = {
    root,
    paths: {
      config: join(root, 'config.json'),
      ledger: join(root, 'ledger.json'),
      packs: join(root, 'packs'),
      tmp: join(root, 'tmp'),
      cache: join(root, 'cache'),
      logs: join(root, 'logs'),
    },
    mode: 'fs',
    degraded: null,
    config: null,
    ledger: null,
  }

  try {
    for (const key of ['packs', 'tmp', 'cache', 'logs']) ensureDir(store.paths[key])
  } catch (err) {
    const fallback = join(tmpdir(), 'dsh-petmarket-' + process.pid)
    try {
      for (const key of ['packs', 'tmp', 'cache', 'logs']) ensureDir(join(fallback, key))
      store.root = fallback
      store.paths = {
        config: join(fallback, 'config.json'),
        ledger: join(fallback, 'ledger.json'),
        packs: join(fallback, 'packs'),
        tmp: join(fallback, 'tmp'),
        cache: join(fallback, 'cache'),
        logs: join(fallback, 'logs'),
      }
      store.degraded = 'storage-degraded'
      store.reason = 'cannot write ' + root + ': ' + (err && err.message ? err.message : err)
    } catch (inner) {
      throw new MarketError('disk-error', 'no writable data root: ' + (inner && inner.message ? inner.message : inner))
    }
  }

  store.config = { ...DEFAULT_CONFIG, ...readJson(store.paths.config, {}) }
  store.config.schemaVersion = 1
  if (!Array.isArray(store.config.sources)) store.config.sources = []
  store.ledger = { ...DEFAULT_LEDGER, ...readJson(store.paths.ledger, {}) }
  if (!isObject(store.ledger.packs)) store.ledger.packs = {}

  store.saveConfig = () => {
    writeJsonAtomic(store.paths.config, store.config)
    return store.config
  }
  store.saveLedger = () => {
    writeJsonAtomic(store.paths.ledger, store.ledger)
    return store.ledger
  }

  store.packDir = (petId, version) => join(store.paths.packs, petId, version)
  store.tmpDir = (jobId) => join(store.paths.tmp, jobId)

  store.list = () => {
    const out = []
    for (const petId of Object.keys(store.ledger.packs)) {
      const record = store.ledger.packs[petId]
      if (!isObject(record)) continue
      const versions = isObject(record.versions) ? record.versions : {}
      out.push({
        petId,
        activeVersion: record.activeVersion || null,
        active: record.active === true,
        sourceRef: record.sourceRef || null,
        versions: Object.keys(versions)
          .sort()
          .map((version) => {
            const entry = versions[version] || {}
            return {
              version,
              state: entry.state || 'installed',
              installedAt: entry.installedAt || null,
              activatedAt: entry.activatedAt || null,
              sha256: entry.sha256 || null,
              sourceRef: entry.sourceRef || null,
              sourceUrl: entry.sourceUrl || null,
              dir: entry.dir || null,
              profile: entry.profile || null,
              bytes: entry.bytes || 0,
              renderer: entry.renderer || null,
              manifest: entry.manifest || null,
            }
          }),
      })
    }
    return out.sort((a, b) => a.petId.localeCompare(b.petId))
  }

  store.get = (petId) => {
    const record = store.ledger.packs[petId]
    if (!isObject(record)) return null
    return record
  }

  store.recordVersion = (petId, version, entry) => {
    const record = isObject(store.ledger.packs[petId]) ? store.ledger.packs[petId] : { versions: {} }
    if (!isObject(record.versions)) record.versions = {}
    record.versions[version] = { ...entry, version, updatedAt: nowIso() }
    if (record.sourceRef === undefined && entry.sourceRef) record.sourceRef = entry.sourceRef
    store.ledger.packs[petId] = record
    store.saveLedger()
    return record
  }

  store.prune = (petId, keep = 1) => {
    const record = store.get(petId)
    if (!record || !isObject(record.versions)) return []
    const versions = Object.keys(record.versions).filter((version) => version !== record.activeVersion)
    versions.sort((a, b) => String(record.versions[a].installedAt || '').localeCompare(String(record.versions[b].installedAt || '')))
    const removed = []
    while (versions.length > Math.max(0, keep)) {
      const version = versions.shift()
      const entry = record.versions[version]
      delete record.versions[version]
      removed.push(version)
      if (entry && entry.dir) {
        try {
          rmSync(entry.dir, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }
    }
    store.saveLedger()
    return removed
  }

  store.removeVersion = (petId, version) => {
    const record = store.get(petId)
    if (!record || !isObject(record.versions) || !record.versions[version]) return false
    const entry = record.versions[version]
    delete record.versions[version]
    if (record.activeVersion === version) {
      record.activeVersion = null
      record.active = false
    }
    if (!Object.keys(record.versions).length) delete store.ledger.packs[petId]
    store.saveLedger()
    if (entry && entry.dir) {
      try {
        rmSync(entry.dir, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    return true
  }

  store.log = (level, message, detail) => {
    const line = JSON.stringify({ at: nowIso(), level, message, detail: detail === undefined ? null : detail })
    try {
      appendFileSync(join(store.paths.logs, 'market.log'), line + '\n', 'utf8')
    } catch {
      // logging must never break the flow
    }
  }

  store.diskUsage = () => {
    let bytes = 0
    let packs = 0
    try {
      for (const petId of readdirSync(store.paths.packs)) {
        const packPath = join(store.paths.packs, petId)
        for (const version of readdirSync(packPath)) {
          packs += 1
          bytes += dirSize(join(packPath, version))
        }
      }
    } catch {
      // ignore
    }
    return { bytes, packs }
  }

  return store
}

function dirSize(path) {
  let total = 0
  try {
    const stat = statSync(path)
    if (stat.isFile()) return stat.size
    for (const name of readdirSync(path)) total += dirSize(join(path, name))
  } catch {
    // ignore
  }
  return total
}
