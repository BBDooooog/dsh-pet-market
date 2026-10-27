// Pack format validation for profile `sprite-sequence/v1`.
// The market never executes pack content: it only proves the package is legal
// and runnable, then hands descriptors to whatever host is present.

import { MarketError, isObject, normalizeRelPath } from './util.js'

export const PROFILE = 'sprite-sequence/v1'
export const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/
export const ANIM_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const BUDGET = {
  maxPackBytes: 20 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxFiles: 512,
  maxAtlasSide: 4096,
  maxFrameSide: 512,
  maxAnimations: 32,
  maxFramesPerAnimation: 128,
  maxTotalFrames: 512,
}

export function readJsonFile(files, path) {
  const raw = files[path]
  if (!raw) return null
  try {
    return JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new MarketError('schema-invalid', 'invalid JSON in ' + path + ': ' + (err && err.message ? err.message : err))
  }
}

export function probeImage(buf) {
  if (!buf || buf.length < 24) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('latin1')
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { type: 'webp', width, height }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  return null
}

function semverParts(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''))
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a, b) {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

function requireObject(value, label) {
  if (!isObject(value)) throw new MarketError('schema-invalid', label + ' must be an object')
  return value
}

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value.trim()) throw new MarketError('schema-invalid', label + ' must be a non-empty string')
  if (pattern && !pattern.test(value)) throw new MarketError('schema-invalid', label + ' has an invalid value: ' + value)
  return value
}

function optionalNumber(value, label, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new MarketError('schema-invalid', label + ' must be a number')
  return n
}

function positiveInt(value, label, fallback) {
  const n = optionalNumber(value, label, fallback)
  if (!Number.isInteger(n) || n <= 0) throw new MarketError('schema-invalid', label + ' must be a positive integer')
  return n
}

// `^1`, `~1.2`, `1.2.3`, `>=1` against runtime version `1.0.0`.
// Partial versions (`1`, `1.2`) are completed with zeros.
export function satisfiesEngines(range, runtimeVersion = '1.0.0') {
  if (range === undefined || range === null || range === '') return true
  const text = String(range).trim()
  const runtime = semverParts(normalizeVersion(runtimeVersion)) || [1, 0, 0]
  if (text.startsWith('^')) {
    const base = semverParts(normalizeVersion(text.slice(1)))
    if (!base) return false
    return runtime[0] === base[0] && compareVersions(normalizeVersion(runtimeVersion), normalizeVersion(text.slice(1))) >= 0
  }
  if (text.startsWith('~')) {
    const base = semverParts(normalizeVersion(text.slice(1)))
    if (!base) return false
    return runtime[0] === base[0] && runtime[1] === base[1] && compareVersions(normalizeVersion(runtimeVersion), normalizeVersion(text.slice(1))) >= 0
  }
  if (text.startsWith('>=')) {
    return compareVersions(normalizeVersion(runtimeVersion), normalizeVersion(text.slice(2))) >= 0
  }
  const exact = semverParts(normalizeVersion(text))
  if (!exact) return false
  return compareVersions(normalizeVersion(runtimeVersion), normalizeVersion(text)) === 0
}

function normalizeVersion(text) {
  const parts = String(text || '').trim().replace(/^v/i, '').split('.')
  if (!parts.length || !/^\d+$/.test(parts[0])) return String(text || '')
  while (parts.length < 3) parts.push('0')
  return parts.slice(0, 3).join('.')
}

function resolveImage(files, baseDir, relPath, code) {
  const clean = normalizeRelPath(relPath)
  if (!clean) throw new MarketError('schema-invalid', 'unsafe asset path: ' + relPath)
  const full = baseDir ? baseDir.replace(/\/$/, '') + '/' + clean : clean
  const buf = files[full]
  if (!buf) throw new MarketError(code || 'asset-missing', 'missing asset: ' + full)
  const probe = probeImage(buf)
  if (!probe) throw new MarketError('image-format-unsupported', 'not a PNG or WebP image: ' + full)
  return { path: full, buffer: buf, ...probe }
}

export function validateRenderer(pet, files, baseDir, warnings) {
  const renderer = requireObject(pet.renderer, 'renderer')
  const type = String(renderer.type || 'sprite')
  if (type !== 'sprite') {
    throw new MarketError('profile-unsupported', 'renderer.type "' + type + '" is outside profile ' + PROFILE)
  }
  const mode = String(renderer.mode || 'sheet')
  if (mode !== 'sheet' && mode !== 'frames') {
    throw new MarketError('schema-invalid', 'renderer.mode must be "sheet" or "frames"')
  }
  const frame = requireObject(renderer.frame, 'renderer.frame')
  const frameW = positiveInt(frame.w, 'renderer.frame.w')
  const frameH = positiveInt(frame.h, 'renderer.frame.h')
  if (frameW > BUDGET.maxFrameSide || frameH > BUDGET.maxFrameSide) {
    throw new MarketError('sheet-geometry', 'frame ' + frameW + 'x' + frameH + ' exceeds ' + BUDGET.maxFrameSide)
  }
  const animationsIn = requireObject(renderer.animations, 'renderer.animations')
  const names = Object.keys(animationsIn)
  if (!names.length) throw new MarketError('schema-invalid', 'renderer.animations is empty')
  if (names.length > BUDGET.maxAnimations) {
    throw new MarketError('schema-invalid', 'too many animations (' + names.length + ')')
  }

  const animations = {}
  let totalFrames = 0
  const out = {
    type: 'sprite',
    mode,
    frame: { w: frameW, h: frameH },
    animations,
    states: {},
    flip: renderer.flip !== false,
    // Which way the drawing itself looks. Optional: packs that omit it are
    // treated as right-facing, which is the common case for side-view sheets.
    front: renderer.front === 'left' ? 'left' : 'right',
  }

  if (mode === 'sheet') {
    const image = resolveImage(files, baseDir, renderer.image, 'asset-missing')
    const grid = isObject(renderer.grid) ? renderer.grid : {}
    const margin = Math.max(0, optionalNumber(grid.margin, 'renderer.grid.margin', 0))
    const spacing = Math.max(0, optionalNumber(grid.spacing, 'renderer.grid.spacing', 0))
    const cols = Math.floor((image.width - 2 * margin + spacing) / (frameW + spacing))
    const rows = Math.floor((image.height - 2 * margin + spacing) / (frameH + spacing))
    if (cols < 1 || rows < 1) {
      throw new MarketError(
        'sheet-geometry',
        'sheet ' + image.width + 'x' + image.height + ' cannot hold a ' + frameW + 'x' + frameH + ' frame',
      )
    }
    for (const name of names) {
      if (!ANIM_NAME_RE.test(name)) throw new MarketError('schema-invalid', 'animation name: ' + name)
      const raw = requireObject(animationsIn[name], 'animations.' + name)
      const row = Math.trunc(optionalNumber(raw.row, 'animations.' + name + '.row', 0))
      const from = Math.trunc(optionalNumber(raw.from, 'animations.' + name + '.from', 0))
      const frames = positiveInt(raw.frames, 'animations.' + name + '.frames')
      const fps = optionalNumber(raw.fps, 'animations.' + name + '.fps', 8)
      if (row < 0 || row >= rows) throw new MarketError('sheet-geometry', 'animation ' + name + ' row ' + row + ' outside sheet (' + rows + ' rows)')
      if (from < 0 || from + frames > cols) {
        throw new MarketError('sheet-geometry', 'animation ' + name + ' spans columns ' + from + '..' + (from + frames - 1) + ' outside sheet (' + cols + ' cols)')
      }
      if (frames > BUDGET.maxFramesPerAnimation) throw new MarketError('schema-invalid', 'animation ' + name + ' has too many frames')
      totalFrames += frames
      animations[name] = {
        row,
        from,
        frames,
        fps: fps > 0 ? Math.min(fps, 120) : 8,
        loop: raw.loop !== false,
        hold: optionalNumber(raw.hold, 'animations.' + name + '.hold', null),
        next: typeof raw.next === 'string' ? raw.next : null,
        direction: raw.direction === 'pingpong' ? 'pingpong' : 'forward',
        events: isObject(raw.events) ? raw.events : null,
      }
    }
    out.image = image.path
    out.sheet = { width: image.width, height: image.height, cols, rows, margin, spacing }
  } else {
    const dir = normalizeRelPath(renderer.framesDir || 'animations')
    if (!dir) throw new MarketError('schema-invalid', 'renderer.framesDir is invalid')
    for (const name of names) {
      if (!ANIM_NAME_RE.test(name)) throw new MarketError('schema-invalid', 'animation name: ' + name)
      const raw = requireObject(animationsIn[name], 'animations.' + name)
      const frames = positiveInt(raw.frames, 'animations.' + name + '.frames')
      if (frames > BUDGET.maxFramesPerAnimation) throw new MarketError('schema-invalid', 'animation ' + name + ' has too many frames')
      const list = []
      for (let i = 0; i < frames; i += 1) {
        const rel = dir + '/' + name + '/' + String(i).padStart(3, '0') + '.png'
        const found = resolveImage(files, baseDir, rel, 'asset-missing')
        list.push(found.path)
      }
      totalFrames += frames
      const fps = optionalNumber(raw.fps, 'animations.' + name + '.fps', 8)
      animations[name] = {
        frames: list.length,
        files: list,
        fps: fps > 0 ? Math.min(fps, 120) : 8,
        loop: raw.loop !== false,
        hold: optionalNumber(raw.hold, 'animations.' + name + '.hold', null),
        next: typeof raw.next === 'string' ? raw.next : null,
        direction: raw.direction === 'pingpong' ? 'pingpong' : 'forward',
      }
    }
    out.framesDir = dir
  }

  if (totalFrames > BUDGET.maxTotalFrames) {
    throw new MarketError('schema-invalid', 'pack declares ' + totalFrames + ' frames (limit ' + BUDGET.maxTotalFrames + ')')
  }
  if (out.sheet && (out.sheet.width > BUDGET.maxAtlasSide || out.sheet.height > BUDGET.maxAtlasSide)) {
    throw new MarketError('sheet-geometry', 'atlas ' + out.sheet.width + 'x' + out.sheet.height + ' exceeds ' + BUDGET.maxAtlasSide + 'px')
  }

  const states = isObject(renderer.states) ? renderer.states : {}
  for (const pose of Object.keys(states)) {
    const target = states[pose]
    if (typeof target !== 'string' || !animations[target]) {
      warnings.push('states.' + pose + ' points at unknown animation "' + String(target) + '" (ignored)')
      continue
    }
    out.states[pose] = target
  }
  if (!out.states.idle) out.states.idle = animations.idle ? 'idle' : names[0]

  if (isObject(renderer.hitbox)) {
    const hb = renderer.hitbox
    out.hitbox = {
      x: optionalNumber(hb.x, 'renderer.hitbox.x', 0),
      y: optionalNumber(hb.y, 'renderer.hitbox.y', 0),
      w: positiveInt(hb.w, 'renderer.hitbox.w', frameW),
      h: positiveInt(hb.h, 'renderer.hitbox.h', frameH),
    }
  }

  const anchor = isObject(pet.anchor) ? pet.anchor : {}
  out.anchor = {
    x: optionalNumber(anchor.x, 'anchor.x', 0.5),
    y: optionalNumber(anchor.y, 'anchor.y', 1),
  }
  out.size = { w: frameW, h: frameH }
  return out
}

// files: { relPath: Buffer }. Returns a normalized pack descriptor.
export function validatePack({ files, expectedId = null, runtimeVersion = '1.0.0' }) {
  const warnings = []
  const names = Object.keys(files)
  if (!names.length) throw new MarketError('zip-invalid', 'package has no files')
  if (names.length > BUDGET.maxFiles) throw new MarketError('zip-invalid', 'package has ' + names.length + ' files (limit ' + BUDGET.maxFiles + ')')

  let manifest = readJsonFile(files, 'manifest.json')
  let pet = readJsonFile(files, 'pet.json')
  if (!manifest && !pet) throw new MarketError('schema-invalid', 'package has neither manifest.json nor pet.json')
  if (pet && !manifest) {
    manifest = { schema: pet.schema, petId: pet.id, version: pet.version }
    warnings.push('manifest.json missing; identity taken from pet.json')
  }
  if (manifest && !pet) throw new MarketError('schema-invalid', 'manifest.json present but pet.json is missing')

  requireObject(manifest, 'manifest.json')
  requireObject(pet, 'pet.json')

  const schema = manifest.schema === undefined ? pet.schema : manifest.schema
  if (Number(schema) !== 1) throw new MarketError('schema-invalid', 'unsupported schema: ' + String(schema))

  const petId = String(manifest.petId || pet.id || '')
  if (!PACK_ID_RE.test(petId)) throw new MarketError('schema-invalid', 'petId must match ' + PACK_ID_RE + ' (got "' + petId + '")')
  if (pet.id && pet.id !== petId) throw new MarketError('schema-invalid', 'manifest.petId "' + petId + '" != pet.json id "' + pet.id + '"')
  if (expectedId && expectedId !== petId) throw new MarketError('pack-id-conflict', 'expected "' + expectedId + '" but package declares "' + petId + '"')

  const version = String(manifest.version || pet.version || '')
  if (!semverParts(version)) throw new MarketError('version-invalid', 'version must be semver, got "' + version + '"')
  if (pet.version && pet.version !== version) throw new MarketError('schema-invalid', 'manifest.version "' + version + '" != pet.json version "' + pet.version + '"')

  const profile = String(manifest.profile || pet.profile || PROFILE)
  if (profile !== PROFILE) throw new MarketError('profile-unsupported', 'unsupported profile "' + profile + '" (this market ships ' + PROFILE + ')')

  const engines = isObject(manifest.engines) ? manifest.engines : isObject(pet.engines) ? pet.engines : {}
  if (!satisfiesEngines(engines.petRuntime, runtimeVersion)) {
    throw new MarketError('engines-mismatch', 'pack needs petRuntime ' + String(engines.petRuntime) + ', market runtime is ' + runtimeVersion)
  }

  const name = requireString(manifest.name || pet.name, 'name')
  const baseDir = ''
  const renderer = validateRenderer(pet, files, baseDir, warnings)

  const market = readJsonFile(files, 'market.json') || {}
  if (isObject(market)) {
    if (market.petId && market.petId !== petId) throw new MarketError('schema-invalid', 'market.json petId mismatch')
    if (market.version && market.version !== version) throw new MarketError('schema-invalid', 'market.json version mismatch')
  }

  if (pet.behavior) warnings.push('behavior/default.json is accepted but not executed by profile v1')

  let bytes = 0
  for (const key of names) bytes += files[key].length

  return {
    petId,
    version,
    profile,
    name,
    description: typeof (manifest.description || pet.description) === 'string' ? manifest.description || pet.description : '',
    author: typeof (manifest.author || pet.author) === 'string' ? manifest.author || pet.author : '',
    license: typeof (manifest.license || pet.license) === 'string' ? manifest.license || pet.license : '',
    homepage: typeof (manifest.homepage || pet.homepage) === 'string' ? manifest.homepage || pet.homepage : '',
    engines,
    renderer,
    bubble: isObject(pet.bubble) ? pet.bubble : null,
    menus: Array.isArray(pet.menus) ? pet.menus : [],
    reactions: isObject(pet.reactions) ? pet.reactions : {},
    actions: isObject(pet.actions) ? pet.actions : {},
    market: {
      tags: Array.isArray(market.tags) ? market.tags.filter((tag) => typeof tag === 'string').slice(0, 8) : [],
      previews: Array.isArray(market.previews) ? market.previews.filter((tag) => typeof tag === 'string').slice(0, 4) : [],
      screenshots: Array.isArray(market.screenshots) ? market.screenshots.filter((tag) => typeof tag === 'string').slice(0, 6) : [],
      changelog: typeof market.changelog === 'string' ? market.changelog : '',
      contact: isObject(market.contact) ? market.contact : null,
    },
    files: names.slice().sort(),
    bytes,
    warnings,
    thumbnail: names.find((entry) => entry === 'thumbnail.png') || names.find((entry) => entry === 'thumbnail.webp') || null,
  }
}
