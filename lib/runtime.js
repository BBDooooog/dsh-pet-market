// Host bridge. Three ways to put a pet on the desktop, in order of preference:
//   1. `pethost`  — the neutral PetHost contract (register/activate/deactivate/unregister)
//   2. `dshpets`  — legacy runtime that exposes registerPack(manifest, files, source)
//   3. local      — nobody to hand the pack to; the market's own client renders it
// The market never imports another plugin's internals: it only calls services.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MarketError, isObject, resolveService } from './util.js'

const CONTRACT_VERSION = '1.0.0'

function listFiles(dir, rel = '', out = []) {
  for (const name of readdirSync(rel ? join(dir, rel) : dir)) {
    const childRel = rel ? rel + '/' + name : name
    const full = join(dir, childRel)
    const stat = statSync(full)
    if (stat.isDirectory()) listFiles(dir, childRel, out)
    else if (stat.isFile()) out.push(childRel)
  }
  return out
}

export function createRuntimeBridge(ctx, logger) {
  const pethost = resolveService(ctx, 'pethost')
  const legacy = resolveService(ctx, 'dshpets')
  const known = new Map()
  const hasPethost = !!(pethost && typeof pethost.register === 'function')
  const hasLegacy = !!(legacy && typeof legacy.registerPack === 'function')
  const mode = hasPethost ? 'pethost' : hasLegacy ? 'legacy' : 'local'

  function remember(entry) {
    known.set(entry.petId, entry)
    return entry
  }

  async function callPethost(method, args) {
    try {
      const value = await pethost[method](...args)
      return value
    } catch (err) {
      const raw = err && err.code ? String(err.code) : ''
      const message = err && err.message ? err.message : String(err)
      if (/engine|version|incompat/i.test(raw + ' ' + message)) throw new MarketError('engines-mismatch', message)
      if (/reject|refus|invalid/i.test(raw + ' ' + message)) throw new MarketError('runtime-rejected', message)
      throw new MarketError('runtime-rejected', message)
    }
  }

  return {
    mode,
    contractVersion: () => (hasPethost && typeof pethost.contractVersion === 'function' ? String(pethost.contractVersion()) : hasLegacy ? 'legacy' : 'local:' + CONTRACT_VERSION),
    descriptor: () => ({ mode, pethost: hasPethost, legacy: hasLegacy, contractVersion: CONTRACT_VERSION }),
    known: () => Array.from(known.values()),

    async register(descriptor) {
      remember(descriptor)
      if (hasPethost) {
        if (typeof pethost.contractVersion === 'function') {
          const running = String(pethost.contractVersion())
          if (running.split('.')[0] !== CONTRACT_VERSION.split('.')[0]) {
            throw new MarketError('engines-mismatch', 'host pet contract ' + running + ' differs from market contract ' + CONTRACT_VERSION)
          }
        }
        await callPethost('register', [descriptor])
        return { ok: true, via: 'pethost' }
      }
      if (hasLegacy) {
        try {
          const files = {}
          const names = listFiles(descriptor.dir)
          for (const name of names) files[name] = readFileSync(join(descriptor.dir, name))
          const result = await legacy.registerPack(descriptor.manifest, files, descriptor.source)
          if (result && result.ok === false) return { ok: false, error: result.error || 'legacy runtime refused the pack' }
          return { ok: true, via: 'dshpets' }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      }
      return { ok: true, via: 'local' }
    },

    async activate(petId) {
      if (hasPethost) {
        await callPethost('activate', [petId])
        return true
      }
      if (hasLegacy && typeof legacy.activate === 'function') {
        try {
          const result = await legacy.activate(petId)
          return result !== false
        } catch {
          return false
        }
      }
      return true
    },

    async deactivate(petId) {
      if (hasPethost && typeof pethost.deactivate === 'function') {
        try {
          await callPethost('deactivate', [petId])
          return true
        } catch {
          return false
        }
      }
      return true
    },

    async unregister(petId) {
      known.delete(petId)
      if (hasPethost && typeof pethost.unregister === 'function') {
        try {
          const value = await callPethost('unregister', [petId])
          return value !== false
        } catch {
          return false
        }
      }
      if (hasLegacy && typeof legacy.unregisterPack === 'function') {
        try {
          return (await legacy.unregisterPack(petId)) !== false
        } catch {
          return false
        }
      }
      return hasPethost ? false : true
    },

    async list() {
      if (hasPethost && typeof pethost.list === 'function') {
        try {
          const value = await pethost.list()
          if (Array.isArray(value) && value.length) return value
        } catch {
          // fall through to the market's own record
        }
      }
      return Array.from(known.values()).map((entry) => ({ packId: entry.petId, version: entry.version }))
    },

    assetUrl(petId, relPath) {
      if (hasPethost && typeof pethost.assetUrl === 'function') {
        try {
          const value = pethost.assetUrl(petId, relPath)
          if (value) return String(value)
        } catch {
          // fall through
        }
      }
      return null
    },

    note(text) {
      if (logger) logger.info(text)
    },
  }
}

export function assertDescriptorShape(entry) {
  if (!isObject(entry) || !entry.petId || !entry.version || !entry.dir) {
    throw new MarketError('invalid-params', 'descriptor needs petId, version and dir')
  }
  return entry
}
