// GitHub as a distribution channel: turn a source reference into one concrete
// release asset, preferring the quota-free direct download path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MarketError } from './util.js'
import { fetchJson } from './download.js'
import { sourceCacheKey } from './sources.js'

const API = 'https://api.github.com'
const CACHE_TTL_MS = 10 * 60 * 1000
export const PACK_ASSET_RE = /\.(dsppet|zip)$/i

export function releaseApiUrl(source, tag) {
  if (!tag || tag === 'latest') return API + '/repos/' + source.owner + '/' + source.repo + '/releases/latest'
  return API + '/repos/' + source.owner + '/' + source.repo + '/releases/tags/' + encodeURIComponent(tag)
}

export function directAssetUrl(source, tag, assetName) {
  const name = encodeURIComponent(assetName)
  if (!tag || tag === 'latest') {
    return 'https://github.com/' + source.owner + '/' + source.repo + '/releases/latest/download/' + name
  }
  return 'https://github.com/' + source.owner + '/' + source.repo + '/releases/download/' + encodeURIComponent(tag) + '/' + name
}

function normalizeAsset(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!name || name.indexOf('/') !== -1) return null
  return {
    name,
    size: Number(raw.size || 0),
    digest: typeof raw.digest === 'string' && raw.digest.startsWith('sha256:') ? raw.digest.slice(7) : null,
    url: typeof raw.browser_download_url === 'string' ? raw.browser_download_url : null,
    apiUrl: typeof raw.url === 'string' ? raw.url : null,
    contentType: typeof raw.content_type === 'string' ? raw.content_type : null,
  }
}

function readCache(cacheDir, key) {
  if (!cacheDir) return null
  const path = join(cacheDir, key + '.json')
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || !value.fetchedAt) return null
    if (Date.now() - value.fetchedAt > CACHE_TTL_MS) return null
    return value.release || null
  } catch {
    return null
  }
}

function writeCache(cacheDir, key, release) {
  if (!cacheDir) return
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, key + '.json'), JSON.stringify({ fetchedAt: Date.now(), release }), 'utf8')
  } catch {
    // cache is optional
  }
}

export async function resolveRelease(source, options = {}) {
  const cacheDir = options.cacheDir ? join(options.cacheDir, 'github') : null
  const key = sourceCacheKey(source, source.tag)
  const cached = options.noCache ? null : readCache(cacheDir, key)
  if (cached) return { ...cached, fromCache: true }

  let payload
  try {
    const result = await fetchJson(releaseApiUrl(source, source.tag), { headers: options.headers })
    payload = result.json
  } catch (err) {
    if (err && err.code === 'github-not-found') {
      throw new MarketError('release-not-found', 'no release found for ' + source.owner + '/' + source.repo + (source.tag ? '@' + source.tag : ''))
    }
    throw err
  }
  if (!payload || typeof payload !== 'object') {
    throw new MarketError('release-not-found', 'release payload was empty for ' + source.owner + '/' + source.repo)
  }
  const assets = Array.isArray(payload.assets) ? payload.assets.map(normalizeAsset).filter(Boolean) : []
  const release = {
    tag: typeof payload.tag_name === 'string' ? payload.tag_name : source.tag || 'latest',
    name: typeof payload.name === 'string' ? payload.name : '',
    body: typeof payload.body === 'string' ? payload.body.slice(0, 4000) : '',
    publishedAt: payload.published_at || null,
    prerelease: payload.prerelease === true,
    draft: payload.draft === true,
    assets,
  }
  writeCache(cacheDir, key, release)
  return release
}

export function pickAsset(release, hint) {
  const assets = (release && release.assets) || []
  if (!assets.length) throw new MarketError('asset-not-found', 'release ' + (release && release.tag) + ' has no assets')
  if (hint) {
    const wanted = String(hint).replace(/^#/, '')
    const exact = assets.find((asset) => asset.name === wanted)
    if (exact) return exact
    const loose = assets.find((asset) => asset.name.toLowerCase() === wanted.toLowerCase())
    if (loose) return loose
    throw new MarketError('asset-not-found', 'release has no asset named "' + wanted + '" (available: ' + assets.map((a) => a.name).join(', ') + ')')
  }
  const packs = assets.filter((asset) => PACK_ASSET_RE.test(asset.name))
  if (!packs.length) {
    throw new MarketError('asset-not-found', 'release has no .dsppet/.zip asset (available: ' + assets.map((a) => a.name).join(', ') + ')')
  }
  packs.sort((a, b) => b.size - a.size)
  return packs[0]
}

export function assetDownloadUrl(source, release, asset) {
  if (asset && asset.url) return asset.url
  return directAssetUrl(source, release && release.tag ? release.tag : source.tag, asset && asset.name)
}

// Resolves { assetName, url, digest, tag, release } for one source.
// Direct /releases/download/ URLs skip the API entirely — that path keeps
// working when the unauthenticated quota is exhausted.
export async function planGithubDownload(source, options = {}) {
  if (source.directAsset) {
    const tag = source.tag === 'latest' ? null : source.tag
    return {
      tag: source.tag || 'latest',
      assetName: source.asset,
      url: tag
        ? directAssetUrl(source, tag, source.asset)
        : directAssetUrl(source, 'latest', source.asset),
      digest: null,
      release: null,
      viaApi: false,
    }
  }
  const release = await resolveRelease(source, options)
  if (release.draft) throw new MarketError('release-not-found', 'release is a draft and cannot be downloaded')
  if (release.prerelease && options.allowPrerelease === false) {
    throw new MarketError('release-not-found', 'release ' + release.tag + ' is a prerelease and prereleases are disabled')
  }
  const asset = pickAsset(release, source.asset)
  return {
    tag: release.tag,
    assetName: asset.name,
    url: assetDownloadUrl(source, release, asset),
    digest: asset.digest,
    size: asset.size,
    release,
    viaApi: true,
  }
}
