// HTTP + SSE surface. One prefix route: /petmarket. Every response is either
// {ok:true,value} or {ok:false,error:{code,message}}.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import {
  MarketError,
  errorPayload,
  isObject,
  mimeOf,
  normalizeRelPath,
  nowIso,
  parsePath,
  parseQuery,
  readJsonBody,
  readRawBody,
  requestTrusted,
  resolveService,
  sendFail,
  sendOk,
} from './util.js'
import { describeSource, parseSource, sourceId } from './sources.js'
import { planGithubDownload } from './github.js'
import { validatePack } from './pack.js'

const PREFIX = '/petmarket'
const API = PREFIX + '/api'

export function createRouter({ store, runtime, logger, getInstaller, getDesktop, getStageToken }) {
  const clients = new Set()
  const listeners = new Set()
  let heartbeat = null
  const disposers = []
  const uiPath = join(store.root, 'ui.json')

  // The installer needs the router's broadcast, and the router needs the
  // installer: resolve it lazily so neither has to exist first.
  function installer() {
    const value = typeof getInstaller === 'function' ? getInstaller() : null
    if (!value) throw new MarketError('runtime-unavailable', 'installer is not ready yet')
    return value
  }

  function readUi() {
    try {
      if (!existsSync(uiPath)) return { positions: {}, names: {}, nameFonts: {}, nameStyles: {}, active: null }
      const value = JSON.parse(readFileSync(uiPath, 'utf8'))
      return isObject(value) ? { positions: {}, names: {}, nameFonts: {}, nameStyles: {}, active: null, ...value } : { positions: {}, names: {}, nameFonts: {}, nameStyles: {}, active: null }
    } catch {
      return { positions: {}, names: {}, nameFonts: {}, nameStyles: {}, active: null }
    }
  }

  function writeUi(next) {
    try {
      mkdirSync(store.root, { recursive: true })
      writeFileSync(uiPath, JSON.stringify(next, null, 2), 'utf8')
    } catch (err) {
      logger.warn('cannot persist ui state', err && err.message ? err.message : err)
    }
    return next
  }

  function writeFrame(client, type, data) {
    let frame
    try {
      frame = 'event: ' + type + '\ndata: ' + JSON.stringify(data == null ? null : data) + '\n\n'
    } catch {
      return
    }
    try {
      client.res.write(frame)
    } catch {
      clients.delete(client)
    }
  }

  function broadcast(type, data) {
    for (const client of Array.from(clients)) writeFrame(client, type, data)
    for (const fn of Array.from(listeners)) {
      try {
        fn(type, data)
      } catch {
        listeners.delete(fn)
      }
    }
  }

  function startHeartbeat() {
    if (heartbeat || typeof setInterval !== 'function') return
    heartbeat = setInterval(() => {
      for (const client of Array.from(clients)) {
        try {
          client.res.write(': ping\n\n')
        } catch {
          clients.delete(client)
        }
      }
      if (!clients.size && heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
    }, 25000)
    if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref()
  }

  function snapshot() {
    return {
      plugin: 'petmarket',
      version: '0.1.0',
      storageMode: store.mode,
      degraded: store.degraded,
      dataRoot: store.root,
      runtime: runtime.descriptor(),
      installed: store.list(),
      jobs: installer().listJobs().slice(0, 20),
      ui: readUi(),
      desktop: typeof getDesktop === 'function' ? getDesktop() : null,
      at: nowIso(),
    }
  }

  function handleStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const client = { res, id: 'c' + Math.random().toString(36).slice(2) }
    clients.add(client)
    writeFrame(client, 'hello', snapshot())
    const drop = () => clients.delete(client)
    req.on('close', drop)
    req.on('error', drop)
    startHeartbeat()
    return undefined
  }

  function findInstalled(petId, version) {
    const record = store.get(petId)
    if (!record || !isObject(record.versions)) return null
    const target = version || record.activeVersion
    const entry = target ? record.versions[target] : null
    if (!entry) return null
    return { record, entry, version: target }
  }

  function serveAsset(res, petId, version, relPath) {
    const found = findInstalled(petId, version)
    if (!found) return sendFail(res, 404, 'pack-not-found', petId + '@' + String(version))
    const clean = normalizeRelPath(relPath)
    if (!clean) return sendFail(res, 400, 'path-traversal', relPath)
    const base = resolvePath(found.entry.dir)
    const full = resolvePath(join(base, clean))
    if (full !== base && !full.startsWith(base + '\\') && !full.startsWith(base + '/')) {
      return sendFail(res, 400, 'path-traversal', relPath)
    }
    if (!existsSync(full) || !statSync(full).isFile()) return sendFail(res, 404, 'asset-missing', clean)
    const body = readFileSync(full)
    res.statusCode = 200
    res.setHeader('content-type', mimeOf(clean))
    res.setHeader('cache-control', 'public, max-age=31536000, immutable')
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(body)
    return undefined
  }

  async function handleInstall(req, res) {
    const body = (await readJsonBody(req)) || {}
    const raw = typeof body.source === 'string' ? body.source : typeof body.url === 'string' ? body.url : ''
    const source = parseSource(raw)
    const kind = source.kind === 'local' ? (source.path.endsWith('.dsppet') || source.path.endsWith('.zip') ? 'local-file' : 'local-dir') : 'github'
    const job = installer().enqueue({
      kind,
      sourceRef: source.sourceRef,
      input: source.kind === 'local' ? source.path : null,
      expectedId: typeof body.petId === 'string' ? body.petId : null,
    })
    return sendOk(res, { job, source: describeSource(source) })
  }

  async function handleResolve(req, res) {
    const body = (await readJsonBody(req)) || {}
    const raw = typeof body.source === 'string' ? body.source : ''
    const source = parseSource(raw)
    if (source.kind === 'local') {
      return sendOk(res, {
        source: describeSource(source),
        kind: 'local',
        plan: { path: source.path, note: 'local sources are verified during install' },
      })
    }
    const plan = await planGithubDownload(source, {
      cacheDir: store.paths.cache,
      allowPrerelease: store.config.allowPrerelease === true,
    })
    return sendOk(res, {
      source: describeSource(source),
      kind: 'github',
      plan: {
        tag: plan.tag,
        assetName: plan.assetName,
        url: plan.url,
        digest: plan.digest,
        size: plan.size || null,
        viaApi: plan.viaApi,
        releaseNotes: plan.release && plan.release.body ? plan.release.body.slice(0, 800) : '',
        prerelease: plan.release ? plan.release.prerelease : false,
      },
    })
  }

  async function handleImport(req, res, query) {
    const filename = typeof query.filename === 'string' ? query.filename : 'upload.dsppet'
    const buffer = await readRawBody(req, 25 * 1024 * 1024)
    if (!buffer || !buffer.length) throw new MarketError('zip-invalid', 'uploaded file is empty')
    const job = installer().enqueue({
      kind: 'upload',
      sourceRef: 'upload:' + filename + ':' + buffer.length,
      input: filename,
      payload: buffer,
    })
    return sendOk(res, { job, filename, bytes: buffer.length })
  }

  async function handleImportLocal(req, res) {
    const body = (await readJsonBody(req)) || {}
    const path = typeof body.path === 'string' ? body.path : ''
    if (!path) throw new MarketError('invalid-params', 'path is required')
    const isFile = /\.(dsppet|zip)$/i.test(path)
    const job = installer().enqueue({
      kind: isFile ? 'local-file' : 'local-dir',
      sourceRef: 'local:' + path,
      input: path,
    })
    return sendOk(res, { job, path })
  }

  async function handler(req, res) {
    const path = parsePath(req.url)
    const query = parseQuery(req.url)
    try {
      if (path === PREFIX || path === PREFIX + '/') {
        res.statusCode = 303
        res.setHeader('location', API + '/health')
        res.end()
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === API + '/health') return sendOk(res, snapshot())
        if (path === API + '/installed') return sendOk(res, { installed: store.list(), runtime: runtime.descriptor() })
        if (path === API + '/jobs') return sendOk(res, { jobs: installer().listJobs() })
        if (path.startsWith(API + '/jobs/')) {
          const jobId = path.slice((API + '/jobs/').length)
          const job = installer().getJob(jobId)
          if (!job) return sendFail(res, 404, 'job-not-found', jobId)
          return sendOk(res, job)
        }
        if (path === API + '/sources') return sendOk(res, { sources: store.config.sources })
        if (path === API + '/catalog') {
          return sendOk(res, {
            sources: store.config.sources,
            installed: store.list(),
            ui: readUi(),
            runtime: runtime.descriptor(),
            desktop: typeof getDesktop === 'function' ? getDesktop() : null,
            storage: { mode: store.mode, degraded: store.degraded, dataRoot: store.root },
          })
        }
        if (path === API + '/stream') return handleStream(req, res)
        const assetPrefix = API + '/packs/'
        if (path.startsWith(assetPrefix)) {
          const rest = path.slice(assetPrefix.length)
          const parts = rest.split('/')
          if (parts.length < 3) return sendFail(res, 404, 'not-found', path)
          const petId = decodeURIComponent(parts[0])
          const version = decodeURIComponent(parts[1])
          const rel = parts.slice(2).map(decodeURIComponent).join('/')
          return serveAsset(res, petId, version, rel)
        }
        return sendFail(res, 404, 'not-found', path)
      }

      if (req.method === 'POST') {
        // The desktop stage is a separate process: it has no browser origin, so
        // it proves itself with a per-install token instead of same-site headers.
        const stageToken = typeof getStageToken === 'function' ? getStageToken() : null
        const presented = req.headers ? req.headers['x-petmarket-stage'] : null
        const fromStage = Boolean(stageToken && presented && presented === stageToken)
        if (path === API + '/stage/position' || path === API + '/stage/click') {
          if (!fromStage) return sendFail(res, 403, 'cross-origin', 'desktop stage token required')
          const body = (await readJsonBody(req)) || {}
          const petId = typeof body.petId === 'string' ? body.petId : ''
          if (!petId) return sendFail(res, 400, 'invalid-params', 'petId required')
          if (path === API + '/stage/position') {
            const ui = readUi()
            const previous = (ui.positions && ui.positions[petId]) || {}
            const nextScale = Number(body.scale)
            ui.positions = {
              ...(ui.positions || {}),
              [petId]: {
                ...previous,
                x: Number(body.x) || 0,
                y: Number(body.y) || 0,
                scale: nextScale > 0 ? nextScale : Number(previous.scale) || undefined,
                facing: Number(body.facing) === -1 ? -1 : 1,
              },
            }
            writeUi(ui)
            broadcast('installed.changed', { petId, positions: ui.positions })
            return sendOk(res, { petId, positions: ui.positions })
          }
          // The right-click menu is allowed to act, not just report: "回窝睡觉"
          // maps onto the same disable path the panel uses.
          const action = typeof body.action === 'string' ? body.action : ''
          if (action === 'sleep') {
            const result = installer().disable(petId)
            broadcast('installed.changed', { petId, positions: readUi().positions })
            return sendOk(res, { petId, action, result })
          }
          broadcast('pet.clicked', { petId, at: nowIso(), action: action || 'click' })
          return sendOk(res, { petId, action: action || 'click' })
        }
        if (!requestTrusted(req)) return sendFail(res, 403, 'cross-origin', 'cross-site request rejected')
        if (path === API + '/install') return await handleInstall(req, res)
        if (path === API + '/resolve') return await handleResolve(req, res)
        if (path === API + '/import') return await handleImport(req, res, query)
        if (path === API + '/import/local') return await handleImportLocal(req, res)
        if (path === API + '/updates/check') {
          const body = (await readJsonBody(req)) || {}
          const raw = typeof body.source === 'string' ? body.source : ''
          const source = parseSource(raw)
          if (source.kind === 'local') return sendOk(res, { available: false, reason: 'local source' })
          const plan = await planGithubDownload(source, { cacheDir: store.paths.cache, allowPrerelease: true })
          const installed = store.get(body.petId || '')
          const current = installed && installed.activeVersion ? installed.activeVersion : null
          return sendOk(res, { latest: plan.tag, assetName: plan.assetName, current, available: !current || plan.tag !== current })
        }
        if (path.startsWith(API + '/jobs/') && path.endsWith('/cancel')) {
          const jobId = path.slice((API + '/jobs/').length, path.length - '/cancel'.length)
          return sendOk(res, installer().cancel(jobId))
        }
        if (path === API + '/sources') {
          const body = (await readJsonBody(req)) || {}
          const raw = typeof body.source === 'string' ? body.source : ''
          const source = parseSource(raw)
          const entry = {
            id: sourceId(source.sourceRef),
            sourceRef: source.sourceRef,
            label: typeof body.label === 'string' && body.label ? body.label : describeSource(source).label,
            kind: source.kind,
            addedAt: nowIso(),
          }
          const exists = store.config.sources.some((item) => item && item.sourceRef === entry.sourceRef)
          if (exists) throw new MarketError('source-duplicate', 'source already added: ' + entry.sourceRef)
          store.config.sources.push(entry)
          store.saveConfig()
          broadcast('sources.changed', { sources: store.config.sources })
          return sendOk(res, { source: entry, sources: store.config.sources })
        }
        if (path.startsWith(API + '/installed/')) {
          const rest = path.slice((API + '/installed/').length)
          const slash = rest.lastIndexOf('/')
          const petId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
          const action = slash === -1 ? '' : rest.slice(slash + 1)
          const body = slash === -1 ? {} : (await readJsonBody(req)) || {}
          if (action === 'activate') {
            const result = await installer().activate(petId, body.version)
            broadcast('installed.changed', result)
            return sendOk(res, result)
          }
          if (action === 'disable') {
            const result = await installer().disable(petId)
            broadcast('installed.changed', result)
            return sendOk(res, result)
          }
          if (action === 'uninstall') {
            const result = await installer().uninstall(petId, body.version)
            broadcast('installed.changed', result)
            return sendOk(res, result)
          }
          if (action === 'rollback') {
            return sendFail(res, 404, 'not-found', path)
          }
          if (action === 'state') {
            const ui = readUi()
            const positions = isObject(ui.positions) ? ui.positions : {}
            const previous = isObject(positions[petId]) ? positions[petId] : {}
            const requestedScale = Number(body.scale)
            const requestedX = Number(body.x)
            const requestedY = Number(body.y)
            positions[petId] = {
              // A scale change from the panel sends only `scale`; keep the saved
              // position instead of teleporting the pet to the top-left corner.
              x: Number.isFinite(requestedX) && body.x !== undefined ? requestedX : Number(previous.x) || 0,
              y: Number.isFinite(requestedY) && body.y !== undefined ? requestedY : Number(previous.y) || 0,
              scale: requestedScale > 0 ? Math.min(8, requestedScale) : Number(previous.scale) || 1,
              facing: body.facing === -1 ? -1 : Number(previous.facing) === -1 && body.facing === undefined ? -1 : 1,
              at: nowIso(),
            }
            const names = isObject(ui.names) ? { ...ui.names } : {}
            const fonts = isObject(ui.nameFonts) ? { ...ui.nameFonts } : {}
            if (typeof body.name === 'string') {
              const trimmed = body.name.trim().slice(0, 40)
              if (trimmed) {
                names[petId] = trimmed
              } else {
                delete names[petId]
              }
            }
            if (body.nameFont === null) {
              delete fonts[petId]
            } else if (body.nameFont !== undefined) {
              const size = Math.round(Number(body.nameFont))
              if (Number.isFinite(size) && size >= 8 && size <= 72) fonts[petId] = size
            }
            // Label look: size, plate colour and font family live in one record
            // so the painter reads a single object per pet.
            const styles = isObject(ui.nameStyles) ? { ...ui.nameStyles } : {}
            const style = isObject(styles[petId]) ? { ...styles[petId] } : {}
            if (body.nameColor === null) delete style.color
            else if (typeof body.nameColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.nameColor)) style.color = body.nameColor
            if (body.nameFamily === null) delete style.family
            else if (typeof body.nameFamily === 'string') {
              const family = body.nameFamily.trim().slice(0, 40)
              if (family) style.family = family
              else delete style.family
            }
            if (body.nameFont !== undefined && fonts[petId] !== undefined) style.size = fonts[petId]
            if (body.nameFont === null) delete style.size
            if (Object.keys(style).length) styles[petId] = style
            else delete styles[petId]
            writeUi({ ...ui, positions, names, nameFonts: fonts, nameStyles: styles })
            broadcast('installed.changed', { petId, positions, names, nameFonts: fonts, nameStyles: styles })
            return sendOk(res, {
              petId,
              position: positions[petId],
              name: names[petId] || null,
              nameFont: fonts[petId] || null,
              nameStyle: styles[petId] || null,
            })
          }
          if (action === 'verify') {
            const found = findInstalled(petId, body.version)
            if (!found) return sendFail(res, 404, 'pack-not-found', petId)
            return sendOk(res, { petId, version: found.version, entry: found.entry })
          }
          return sendFail(res, 404, 'not-found', path)
        }
        if (path === API + '/active') {
          const body = (await readJsonBody(req)) || {}
          const petId = typeof body.petId === 'string' ? body.petId : null
          // `ui.active` used to be a second source of truth; the ledger owns it now,
          // so this endpoint has to go through the installer instead of writing a flag.
          if (petId) {
            await installer().activate(petId, body.version)
          } else {
            const living = (store.list() || []).find((item) => item && item.active === true)
            const current = (living && living.petId) || readUi().active
            if (current) await installer().disable(current)
          }
          writeUi({ ...readUi(), active: petId })
          broadcast('installed.changed', { active: petId })
          return sendOk(res, { active: petId })
        }
        return sendFail(res, 404, 'not-found', path)
      }

      if (req.method === 'DELETE') {
        if (!requestTrusted(req)) return sendFail(res, 403, 'cross-origin', 'cross-site request rejected')
        if (path.startsWith(API + '/sources/')) {
          const id = decodeURIComponent(path.slice((API + '/sources/').length))
          const before = store.config.sources.length
          store.config.sources = store.config.sources.filter((item) => item && item.id !== id)
          if (store.config.sources.length === before) throw new MarketError('not-found', 'no such source: ' + id)
          store.saveConfig()
          broadcast('sources.changed', { sources: store.config.sources })
          return sendOk(res, { sources: store.config.sources })
        }
        return sendFail(res, 404, 'not-found', path)
      }

      return sendFail(res, 405, 'not-found', 'method not allowed: ' + String(req.method))
    } catch (err) {
      const payload = errorPayload(err)
      if (logger && payload.status >= 500) logger.error('request failed: ' + path, { code: payload.code, message: payload.message })
      return sendFail(res, payload.status, payload.code, payload.message, payload.extra)
    }
  }

  function attach(ctx) {
    // Declared as an optional inject on the plugin, so the property read is
    // allowed both in a plain cordis scope and behind the DSH sandbox facade.
    let webServer = null
    try {
      webServer = ctx && ctx.webServer ? ctx.webServer : null
    } catch {
      webServer = null
    }
    if (!webServer) webServer = resolveService(ctx, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      return { available: false, reason: 'web-server-unavailable' }
    }
    const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
    return { available: true, basePath: PREFIX }
  }

  function dispose() {
    for (const fn of disposers.splice(0)) {
      try {
        fn()
      } catch {
        // already gone
      }
    }
    for (const client of Array.from(clients)) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    clients.clear()
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  return {
    attach,
    dispose,
    broadcast,
    snapshot,
    handler,
    readUi,
    writeUi,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    route: { prefix: PREFIX, api: API },
  }
}



