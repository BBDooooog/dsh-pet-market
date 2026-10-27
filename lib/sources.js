// Source references. Two families exist in v1:
//   github:owner/repo[@tag][#asset]   → release asset from GitHub
//   local:<absolute path>             → a .dsppet file or an unpacked pack folder
// Everything else is rejected with `source-invalid`.

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { MarketError } from './util.js'

const GH_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const GH_HOSTS = new Set(['github.com', 'www.github.com'])

export function sourceId(sourceRef) {
  return createHash('sha1').update(String(sourceRef)).digest('hex').slice(0, 12)
}

function fromGithubPath(owner, repo, rest) {
  const clean = { owner, repo, tag: null, asset: null, kind: 'github' }
  if (!rest) return clean
  const segments = rest.split('/').filter(Boolean)
  if (segments[0] !== 'releases') {
    return clean
  }
  if (segments[1] === 'tag' && segments[2]) {
    clean.tag = decodeURIComponent(segments[2])
    if (segments[3] === 'download' && segments[4]) clean.asset = decodeURIComponent(segments.slice(4).join('/'))
    return clean
  }
  // /releases/latest/download/<asset> — the shape GitHub shows on the web
  if (segments[1] === 'latest') {
    clean.tag = 'latest'
    if (segments[2] === 'download' && segments[3]) clean.asset = decodeURIComponent(segments.slice(3).join('/'))
    return clean
  }
  // /releases/download/<tag>/<asset>
  if (segments[1] === 'download') {
    if (segments[2]) clean.tag = decodeURIComponent(segments[2])
    if (segments[3]) clean.asset = decodeURIComponent(segments.slice(3).join('/'))
    return clean
  }
  return clean
}

export function parseSource(text, options = {}) {
  // `sourceRef` values carry a `github:` prefix (`github:owner/repo@tag#asset`)
  // and the installer feeds them straight back in, so the prefix has to be
  // accepted here or every GitHub install fails with source-invalid.
  const raw = String(text == null ? '' : text).trim().replace(/^github:/i, '')
  if (!raw) throw new MarketError('source-invalid', 'source is empty')

  if (/^local:/i.test(raw)) {
    const path = raw.slice(6).trim()
    if (!path) throw new MarketError('source-invalid', 'local source needs a path')
    if (!isAbsolute(path) && !/^[a-zA-Z]:[\\/]/.test(path)) {
      throw new MarketError('source-invalid', 'local source must be an absolute path')
    }
    return { kind: 'local', path, sourceRef: 'local:' + path, input: raw }
  }

  // owner/repo[@tag][#asset] — the asset hint picks one .dsppet out of a release
  // that ships several pets.
  const hashAt = raw.indexOf('#')
  const head = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const assetHint = hashAt >= 0 ? decodeURIComponent(raw.slice(hashAt + 1)).trim() : null
  const repoRef = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@([^\s#/]+))?$/.exec(head)
  if (repoRef) {
    const [, owner, repo, tag] = repoRef
    return {
      kind: 'github',
      owner,
      repo,
      tag: tag || null,
      asset: assetHint || null,
      sourceRef: 'github:' + owner + '/' + repo + (tag ? '@' + tag : '') + (assetHint ? '#' + assetHint : ''),
      input: raw,
    }
  }

  let url = null
  try {
    url = new URL(raw)
  } catch {
    url = null
  }
  if (!url) throw new MarketError('source-invalid', 'unrecognized source: ' + raw)
  if (url.protocol !== 'https:') throw new MarketError('source-invalid', 'only https sources are supported')

  if (GH_HOSTS.has(url.hostname.toLowerCase())) {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length < 2) throw new MarketError('source-invalid', 'URL does not point at a repository')
    const owner = segments[0]
    const repo = segments[1].replace(/\.git$/, '')
    const parsed = fromGithubPath(owner, repo, segments.slice(2).join('/'))
    parsed.sourceRef = 'github:' + owner + '/' + repo + (parsed.tag ? '@' + parsed.tag : '') + (parsed.asset ? '#' + parsed.asset : '')
    parsed.input = raw
    parsed.directAsset = !!(parsed.tag && parsed.asset)
    return parsed
  }

  if (url.hostname.toLowerCase() === 'api.github.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1]
      const repo = segments[2]
      const parsed = { kind: 'github', owner, repo, tag: null, asset: null, input: raw }
      const releasesAt = segments.indexOf('releases')
      if (releasesAt !== -1 && segments[releasesAt + 2]) parsed.tag = decodeURIComponent(segments[releasesAt + 2])
      parsed.sourceRef = 'github:' + owner + '/' + repo + (parsed.tag ? '@' + parsed.tag : '')
      return parsed
    }
  }

  throw new MarketError('source-invalid', 'unsupported host: ' + url.hostname)
}

export function describeSource(source) {
  if (!source) return null
  if (source.kind === 'local') return { kind: 'local', label: source.path, sourceRef: source.sourceRef }
  return {
    kind: 'github',
    label: source.owner + '/' + source.repo + (source.tag ? '@' + source.tag : ''),
    owner: source.owner,
    repo: source.repo,
    tag: source.tag,
    asset: source.asset,
    sourceRef: source.sourceRef,
  }
}

export function sourceCacheKey(source, tag) {
  return [source.owner, source.repo, tag || 'latest'].join('__').replace(/[^A-Za-z0-9._@-]/g, '_')
}
