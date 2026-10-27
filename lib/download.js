// Network primitives: JSON fetch with retry/ETag, and streamed downloads that
// hash while they write and enforce a hard byte cap.

import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { MarketError, sleep } from './util.js'

export const UA = 'dsh-pet-market/0.1 (+https://github.com/dsh-pets/dsh-pet-market)'
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

class Retryable extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function headersFor(extra) {
  return {
    'user-agent': UA,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(extra || {}),
  }
}

/**
 * A token lifts the unauthenticated quota from 60 requests/hour to 5,000. It is
 * only ever attached to api.github.com: asset downloads land on
 * objects.githubusercontent.com with pre-signed URLs, and leaking the header to
 * a host we do not control is not worth the few saved redirects.
 */
export function authHeadersFor(url, extra) {
  const headers = headersFor(extra)
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  if (host === 'api.github.com') {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (token) headers.authorization = 'Bearer ' + token
  }
  return headers
}

export async function fetchWithRetry(url, options = {}) {
  const attempts = options.attempts || 3
  const timeoutMs = options.timeoutMs || 30000
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: authHeadersFor(url, options.headers),
        redirect: 'follow',
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (response.ok) return response
      const status = response.status
      if (status === 403 || status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining')
        if (remaining === '0' || status === 429) {
          const reset = Number(response.headers.get('x-ratelimit-reset') || 0)
          throw new MarketError('github-rate-limited', 'GitHub API quota exhausted', {
            retryAt: reset ? new Date(reset * 1000).toISOString() : null,
          })
        }
      }
      if (status === 401) throw new MarketError('github-unauthorized', 'GitHub rejected the request (401)')
      if (status === 404) throw new MarketError('github-not-found', 'not found: ' + url)
      if (RETRYABLE.has(status)) throw new Retryable(status, 'HTTP ' + status + ' from ' + url)
      throw new MarketError('download-failed', 'HTTP ' + status + ' from ' + url)
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof MarketError) throw err
      lastError = err
      if (attempt === attempts) break
      await sleep(400 * attempt * attempt)
    }
  }
  const message = lastError && lastError.message ? lastError.message : String(lastError)
  if (lastError instanceof Retryable) {
    throw new MarketError('download-failed', message)
  }
  throw new MarketError('download-failed', 'request failed: ' + message)
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, options)
  const text = await response.text()
  try {
    return { json: JSON.parse(text), headers: response.headers, status: response.status }
  } catch {
    throw new MarketError('download-failed', 'expected JSON but got something else from ' + url)
  }
}

export async function downloadToFile(url, dest, options = {}) {
  const maxBytes = options.maxBytes || 20 * 1024 * 1024
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  mkdirSync(dirname(dest), { recursive: true })
  const response = await fetchWithRetry(url, { headers: options.headers, timeoutMs: options.timeoutMs || 60000 })
  const total = Number(response.headers.get('content-length') || 0)
  if (total && total > maxBytes) {
    throw new MarketError('asset-too-large', 'asset is ' + total + ' bytes (limit ' + maxBytes + ')')
  }
  const hash = createHash('sha256')
  let written = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    written += chunk.length
    if (written > maxBytes) {
      source.destroy(new MarketError('asset-too-large', 'asset exceeds ' + maxBytes + ' bytes'))
      return
    }
    hash.update(chunk)
    if (onProgress) onProgress({ received: written, total })
  })
  try {
    await pipeline(source, createWriteStream(dest))
  } catch (err) {
    try {
      rmSync(dest, { force: true })
    } catch {
      // ignore
    }
    if (err instanceof MarketError) throw err
    throw new MarketError('download-failed', 'download failed: ' + (err && err.message ? err.message : err))
  }
  if (total && written !== total) {
    try {
      rmSync(dest, { force: true })
    } catch {
      // ignore
    }
    throw new MarketError('download-failed', 'truncated download (' + written + '/' + total + ' bytes)')
  }
  return { bytes: written, sha256: hash.digest('hex') }
}
