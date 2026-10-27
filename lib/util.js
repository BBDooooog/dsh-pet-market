// Shared helpers for the pet market Host half. No dependencies beyond node builtins.

export class MarketError extends Error {
  constructor(code, message, extra) {
    super(message || code)
    this.name = 'MarketError'
    this.code = code
    this.extra = extra || null
  }
}

export function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Rejects absolute paths, drive letters, NUL bytes and every `..` segment.
export function normalizeRelPath(raw) {
  const text = String(raw == null ? '' : raw).replace(/\\/g, '/')
  if (!text) return null
  if (text.indexOf('\0') !== -1) return null
  if (text.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(text)) return null
  const parts = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    parts.push(segment)
  }
  if (!parts.length) return null
  return parts.join('/')
}

const MIME = {
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
}

export function mimeOf(path) {
  const text = String(path || '').toLowerCase()
  const dot = text.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return MIME[text.slice(dot + 1)] || 'application/octet-stream'
}

export function parsePath(rawUrl) {
  const text = String(rawUrl == null ? '/' : rawUrl)
  const q = text.indexOf('?')
  const path = q === -1 ? text : text.slice(0, q)
  return path.startsWith('/') ? path : '/' + path
}

export function parseQuery(rawUrl) {
  const out = {}
  const text = String(rawUrl == null ? '' : rawUrl)
  const q = text.indexOf('?')
  if (q === -1) return out
  for (const part of text.slice(q + 1).split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const rawKey = eq === -1 ? part : part.slice(0, eq)
    const rawValue = eq === -1 ? '' : part.slice(eq + 1)
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    } catch {
      out[rawKey] = rawValue
    }
  }
  return out
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

export function sendOk(res, value) {
  sendJson(res, 200, { ok: true, value: value === undefined ? null : value })
}

export function sendFail(res, status, code, message, extra) {
  sendJson(res, status, {
    ok: false,
    error: { code, message: message || code, ...(isObject(extra) ? extra : {}) },
  })
}

export function readJsonBody(req, limit = 256 * 1024) {
  return readRawBody(req, limit).then((buf) => {
    if (!buf || !buf.length) return null
    try {
      return JSON.parse(buf.toString('utf8'))
    } catch {
      throw new MarketError('bad-json', 'request body is not valid JSON')
    }
  })
}

export function readRawBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > limit) {
        finish(reject, new MarketError('body-too-large', 'request body exceeds ' + limit + ' bytes'))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
    req.on('error', (err) => finish(reject, err))
  })
}

function hostOfUrl(url) {
  const text = String(url || '')
  const scheme = text.indexOf('://')
  const rest = scheme === -1 ? text : text.slice(scheme + 3)
  const slash = rest.indexOf('/')
  return slash === -1 ? rest : rest.slice(0, slash)
}

// Browser writes must come from the page that hosts the market.
export function requestTrusted(req) {
  const headers = (req && req.headers) || {}
  const site = headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (origin) {
    const host = headers.host
    if (!host) return false
    if (hostOfUrl(origin).toLowerCase() !== String(host).toLowerCase()) return false
  }
  return true
}

export function resolveService(ctx, name) {
  if (!ctx) return null
  // DSH runs host halves behind a sandbox facade: ctx.get(name) is always
  // readable, while ctx[name] throws for every service that was not declared in
  // inject. So all lookups go through get(), and a throw means "absent".
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value) return value
    } catch {
      // service missing, or the facade refused the read
    }
  }
  return null
}

export function loggerOf(ctx) {
  const logger = resolveService(ctx, 'logger')
  function emit(level, message, detail) {
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
    if (fn) {
      try {
        if (detail === undefined) fn(message)
        else fn(message, detail)
        return
      } catch {
        // fall through
      }
    }
    const text = '[petmarket] ' + message
    if (level === 'error' && typeof console !== 'undefined' && console.error) console.error(text, detail === undefined ? '' : detail)
    else if (level !== 'error' && typeof console !== 'undefined' && console.log) console.log(text, detail === undefined ? '' : detail)
  }
  return {
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  }
}

const CLIENT_ERROR_CODES = new Set([
  'bad-json',
  'body-too-large',
  'invalid-params',
  'job-not-found',
  'not-found',
  'pack-not-found',
  'source-invalid',
  'source-duplicate',
])

export function errorPayload(err) {
  if (err instanceof MarketError) return { status: 400, code: err.code, message: err.message, extra: err.extra }
  const code = err && typeof err.code === 'string' && /^[a-z0-9-]+$/.test(err.code) ? err.code : 'internal-error'
  const message = err && err.message ? String(err.message) : String(err || 'unknown error')
  let status = 500
  if (code === 'not-found' || code === 'pack-not-found' || code === 'job-not-found') status = 404
  else if (code === 'cross-origin') status = 403
  else if (CLIENT_ERROR_CODES.has(code)) status = 400
  return { status, code, message, extra: null }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nowIso() {
  return new Date().toISOString()
}
