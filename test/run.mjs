// node --test  → node test/run.mjs
// Exercises the parts that can run headless: zip reading, pack validation,
// source parsing, GitHub planning (offline), the installer against a fake pet
// host, and the HTTP surface with a fake web server.

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { extractAll, openZip } from '../lib/zip.js'
import { validatePack } from '../lib/pack.js'
import { parseSource, describeSource } from '../lib/sources.js'
import { planGithubDownload } from '../lib/github.js'
import { openStore } from '../lib/ledger.js'
import { createInstaller } from '../lib/install.js'
import { createRouter } from '../lib/router.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEMO_PACK = join(HERE, '..', 'demo', 'dist', 'pixel-cat-1.2.0.dsppet')

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'petmarket-test-'))
}

function demoFiles() {
  const zip = openZip(readFileSync(DEMO_PACK))
  return extractAll(zip)
}

// ---------------------------------------------------------------- zip + pack

test('demo package opens and validates', () => {
  const files = demoFiles()
  assert.ok(files['pet.json'], 'pet.json present')
  assert.ok(files['thumbnail.png'], 'thumbnail.png present')
  const descriptor = validatePack({ files })
  assert.equal(descriptor.petId, 'pixel-cat')
  assert.equal(descriptor.version, '1.2.0')
  assert.deepEqual(Object.keys(descriptor.renderer.animations).sort(), ['idle', 'run', 'walk'])
  assert.equal(descriptor.renderer.sheet.cols, 6)
  assert.equal(descriptor.renderer.sheet.rows, 3)
})

test('bad identity is rejected', () => {
  const files = demoFiles()
  const pet = JSON.parse(String(files['pet.json']))
  pet.id = 'Pixel Cat'
  files['pet.json'] = Buffer.from(JSON.stringify(pet))
  assert.throws(() => validatePack({ files }), (err) => err.code === 'schema-invalid')

  const again = demoFiles()
  again['manifest.json'] = Buffer.from(JSON.stringify({ schema: 1, petId: 'other-cat', version: '1.0.0', profile: 'sprite-sequence/v1' }))
  assert.throws(() => validatePack({ files: again }), (err) => err.code === 'schema-invalid')
})

test('engine mismatch is rejected', () => {
  const files = demoFiles()
  const pet = JSON.parse(String(files['pet.json']))
  pet.engines = { petRuntime: '^9' }
  files['pet.json'] = Buffer.from(JSON.stringify(pet))
  delete files['manifest.json']
  assert.throws(() => validatePack({ files }), (err) => err.code === 'engines-mismatch')
})

test('missing atlas is rejected', () => {
  const files = demoFiles()
  delete files['animations/cat.png']
  assert.throws(() => validatePack({ files }), (err) => err.code === 'asset-missing')
})

test('sheet geometry overflow is rejected', () => {
  const files = demoFiles()
  const pet = JSON.parse(String(files['pet.json']))
  pet.renderer.animations.walk.frames = 20
  files['pet.json'] = Buffer.from(JSON.stringify(pet))
  assert.throws(() => validatePack({ files }), (err) => err.code === 'sheet-geometry')
})

// ------------------------------------------------------------------ sources

test('source parsing covers every accepted shape', () => {
  assert.equal(parseSource('octo/pet-cat').sourceRef, 'github:octo/pet-cat')
  assert.equal(parseSource('octo/pet-cat@1.2.0').tag, '1.2.0')
  const release = parseSource('https://github.com/octo/pet-cat/releases/tag/v2.0.0')
  assert.equal(release.owner, 'octo')
  assert.equal(release.tag, 'v2.0.0')
  const direct = parseSource('https://github.com/octo/pet-cat/releases/latest/download/pet.dsppet')
  assert.equal(direct.directAsset, true)
  assert.equal(direct.asset, 'pet.dsppet')
  const local = parseSource('local:D:/packs/pet.dsppet')
  assert.equal(local.kind, 'local')
  assert.equal(describeSource(local).label.includes('pet.dsppet'), true)
  assert.throws(() => parseSource(''), (err) => err.code === 'source-invalid')
  assert.throws(() => parseSource('https://example.com/whatever'), (err) => err.code === 'source-invalid')
})

test('direct release asset plans without touching the API', async () => {
  const source = parseSource('https://github.com/octo/pet-cat/releases/download/v1.0.0/pet.dsppet')
  const plan = await planGithubDownload(source, {})
  assert.equal(plan.viaApi, false)
  assert.equal(plan.assetName, 'pet.dsppet')
  assert.equal(plan.url, 'https://github.com/octo/pet-cat/releases/download/v1.0.0/pet.dsppet')
})

// ---------------------------------------------------------------- installer

function fakeHost() {
  const calls = []
  const packs = new Map()
  return {
    calls,
    packs,
    contractVersion: () => '1.0.0',
    register: async (descriptor) => {
      calls.push(['register', descriptor.petId, descriptor.version])
      if (packs.has(descriptor.petId)) throw new Error('pack-id-conflict: already registered')
      packs.set(descriptor.petId, descriptor)
      return { ok: true }
    },
    activate: async (petId) => {
      calls.push(['activate', petId])
      if (!packs.has(petId)) throw new Error('unknown pack ' + petId)
      return { ok: true }
    },
    deactivate: async (petId) => {
      calls.push(['deactivate', petId])
      return true
    },
    unregister: async (petId) => {
      calls.push(['unregister', petId])
      return packs.delete(petId)
    },
    list: async () => Array.from(packs.values()).map((entry) => ({ packId: entry.petId, version: entry.version })),
  }
}

function fakeCtx(services) {
  return { get: (name) => services[name] || null }
}

async function waitForJob(installer, jobId, timeoutMs = 20000) {
  const start = Date.now()
  for (;;) {
    const job = installer.getJob(jobId)
    if (job && (job.phase === 'done' || job.phase === 'failed')) return job
    if (Date.now() - start > timeoutMs) throw new Error('job timeout: ' + JSON.stringify(job))
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

test('installer commits a local package and registers it with the host', async () => {
  const root = tempRoot()
  const host = fakeHost()
  const ctx = fakeCtx({ pethost: host })
  const store = openStore({ dataRoot: root })
  const events = []
  const runtime = (await import('../lib/runtime.js')).createRuntimeBridge(ctx, null)
  const installer = createInstaller({ store, runtime, config: { keepVersions: 1 }, events: { broadcast: (type, data) => events.push([type, data]) } })

  const job = installer.enqueue({ kind: 'local-file', sourceRef: 'local:' + DEMO_PACK, input: DEMO_PACK })
  const done = await waitForJob(installer, job.jobId)
  assert.equal(done.phase, 'done', JSON.stringify(done))
  assert.equal(done.result.petId, 'pixel-cat')

  const installed = store.list()
  assert.equal(installed.length, 1)
  assert.equal(installed[0].petId, 'pixel-cat')
  assert.equal(installed[0].activeVersion, '1.2.0')
  assert.ok(readFileSync(join(installed[0].versions[0].dir, 'pet.json')).length > 0)

  // Installing stocks the shelf; the animal only appears once it is asked for.
  assert.deepEqual(host.calls.map((call) => call[0]), ['register'], JSON.stringify(host.calls.map((c) => c[0])))
  assert.equal(installed[0].active, false, 'a fresh install stays home')
  assert.ok(events.some(([type]) => type === 'job.done'))

  await installer.activate('pixel-cat')
  assert.deepEqual(host.calls.map((call) => call[0]), ['register', 'activate'], JSON.stringify(host.calls.map((c) => c[0])))

  const removed = await installer.uninstall('pixel-cat')
  assert.equal(removed.petId, 'pixel-cat')
  assert.equal(host.packs.size, 0)

  rmSync(root, { recursive: true, force: true })
})

test('the same package twice keeps one version and does not double register', async () => {
  const root = tempRoot()
  const host = fakeHost()
  const ctx = fakeCtx({ pethost: host })
  const store = openStore({ dataRoot: root })
  const runtime = (await import('../lib/runtime.js')).createRuntimeBridge(ctx, null)
  const installer = createInstaller({ store, runtime, config: { keepVersions: 1 } })

  const first = installer.enqueue({ kind: 'local-file', sourceRef: 'local:' + DEMO_PACK, input: DEMO_PACK })
  assert.equal((await waitForJob(installer, first.jobId)).phase, 'done')
  const second = installer.enqueue({ kind: 'local-file', sourceRef: 'local:' + DEMO_PACK, input: DEMO_PACK })
  assert.equal((await waitForJob(installer, second.jobId)).phase, 'done')

  const installed = store.list()
  assert.equal(installed[0].versions.length, 1)
  assert.equal(host.packs.size, 1)

  rmSync(root, { recursive: true, force: true })
})

// ------------------------------------------------------------------- router

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader: (name, value) => {
      res.headers[name.toLowerCase()] = value
    },
    writeHead: (status, headers) => {
      res.statusCode = status
      for (const [name, value] of Object.entries(headers || {})) res.headers[name.toLowerCase()] = value
    },
    write: (chunk) => {
      res.chunks.push(String(chunk))
    },
    end: (chunk) => {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      res.done = true
    },
  }
  res.body = () => {
    const text = res.chunks.join('')
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return res
}

function fakeReq(method, url, { body, headers } = {}) {
  const listeners = {}
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:54438', ...(headers || {}) },
    on(event, handler) {
      listeners[event] = listeners[event] || []
      listeners[event].push(handler)
      return req
    },
    destroy() {},
  }
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  setTimeout(() => {
    for (const handler of listeners.data || []) for (const chunk of chunks) handler(chunk)
    for (const handler of listeners.end || []) handler()
  }, 0)
  return req
}

async function withRouter(run) {
  const root = tempRoot()
  const host = fakeHost()
  const ctx = fakeCtx({ pethost: host })
  const store = openStore({ dataRoot: root })
  const runtime = (await import('../lib/runtime.js')).createRuntimeBridge(ctx, null)
  const router = createRouter({ store, runtime, logger: null, getInstaller: () => installer })
  const installer = createInstaller({ store, runtime, config: { keepVersions: 1 }, events: { broadcast: (type, data) => router.broadcast(type, data) } })
  try {
    await run({ router, installer, store, host })
  } finally {
    router.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

test('health returns the standard envelope', async () => {
  await withRouter(async ({ router }) => {
    const res = fakeRes()
    await router.handler(fakeReq('GET', '/petmarket/api/health'), res)
    const payload = res.body()
    assert.equal(payload.ok, true)
    assert.equal(payload.value.plugin, 'petmarket')
    assert.equal(payload.value.runtime.mode, 'pethost')
  })
})

test('cross-site writes are refused', async () => {
  await withRouter(async ({ router }) => {
    const res = fakeRes()
    await router.handler(fakeReq('POST', '/petmarket/api/sources', { body: { source: 'octo/pet-cat' }, headers: { 'sec-fetch-site': 'cross-site' } }), res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body().error.code, 'cross-origin')
  })
})

test('sources can be added, listed and removed', async () => {
  await withRouter(async ({ router }) => {
    const add = fakeRes()
    await router.handler(fakeReq('POST', '/petmarket/api/sources', { body: { source: 'octo/pet-cat', label: 'Pet Cat' }, headers: { 'sec-fetch-site': 'same-origin' } }), add)
    assert.equal(add.body().ok, true)
    const id = add.body().value.source.id

    const list = fakeRes()
    await router.handler(fakeReq('GET', '/petmarket/api/sources'), list)
    assert.equal(list.body().value.sources.length, 1)

    const remove = fakeRes()
    await router.handler(fakeReq('DELETE', '/petmarket/api/sources/' + id, { headers: { 'sec-fetch-site': 'same-origin' } }), remove)
    assert.equal(remove.body().value.sources.length, 0)
  })
})

test('upload import installs a dragged package', async () => {
  await withRouter(async ({ router, store, host }) => {
    const res = fakeRes()
    await router.handler(
      fakeReq('POST', '/petmarket/api/import?filename=pixel-cat.dsppet', {
        body: readFileSync(DEMO_PACK),
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream' },
      }),
      res,
    )
    const payload = res.body()
    assert.equal(payload.ok, true, JSON.stringify(payload))
    const jobId = payload.value.job.jobId

    let job = null
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const poll = fakeRes()
      await router.handler(fakeReq('GET', '/petmarket/api/jobs/' + jobId), poll)
      job = poll.body().value
      if (job.phase === 'done' || job.phase === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(job.phase, 'done', JSON.stringify(job))
    assert.equal(store.list()[0].petId, 'pixel-cat')
    assert.deepEqual(host.calls.map((call) => call[0]), ['register'], JSON.stringify(host.calls.map((c) => c[0])))
  })
})

// ------------------------------------------------------- plugin boot (index.js)

test('the plugin boots against a DSH-like context', async () => {
  const { apply } = await import('../index.js')
  const root = tempRoot()
  const host = fakeHost()
  const routes = []
  const provided = new Map()
  const effects = []
  const services = {
    pethost: host,
    logger: null,
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {
          spec.disposed = true
        }
      },
    },
  }
  const ctx = {
    get: (nameService) => services[nameService] || null,
    provide: (nameService, value) => provided.set(nameService, value),
    effect: (fn) => {
      effects.push(fn())
    },
  }

  apply(ctx, { dataRoot: root })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/petmarket')
  assert.equal(routes[0].kind, 'prefix')
  assert.ok(provided.has('petmarket'))

  const api = provided.get('petmarket')
  assert.equal(api.version, '0.1.0')
  assert.equal(api.mode, 'pethost')

  const health = fakeRes()
  await routes[0].handler(fakeReq('GET', '/petmarket/api/health'), health)
  const payload = health.body()
  assert.equal(payload.ok, true)
  assert.equal(payload.value.runtime.mode, 'pethost')
  assert.equal(payload.value.dataRoot, root)

  const job = api.install('local:' + DEMO_PACK)
  let finished = null
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const poll = fakeRes()
    await routes[0].handler(fakeReq('GET', '/petmarket/api/jobs/' + job.jobId), poll)
    finished = poll.body().value
    if (finished.phase === 'done' || finished.phase === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(finished.phase, 'done', JSON.stringify(finished))

  for (const dispose of effects) dispose()
  assert.equal(routes[0].disposed, true)
  rmSync(root, { recursive: true, force: true })
})

// ------------------------------------------------------------- client half

test('the client half registers both seats without a bundler', () => {
  const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
  let spec = null
  const fakeWindow = {
    __ModuleLoader__: { load(value) { spec = value } },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  }
  const fakeDocument = { baseURI: 'http://127.0.0.1:54438/', addEventListener() {}, removeEventListener() {} }
  const factory = new Function('window', 'document', 'EventSource', 'fetch', source)
  factory(fakeWindow, fakeDocument, class { addEventListener() {} close() {} }, async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, value: {} }),
  }))

  assert.equal(spec.id, 'dsh-pet-market')
  const fakeReact = {
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
  }
  const moduleExports = spec.factory((packageName) => {
    if (packageName === 'react') return fakeReact
    throw new Error('unexpected require: ' + packageName)
  })
  const seats = []
  const ctx = {
    get(serviceName) {
      if (serviceName === 'slots') {
        return {
          register(node, Component) {
            // The live settings shell maps options.label through resolveSlotLabel
            // and renders '' when it is absent, so an unlabeled row is blank.
            if ((node.name === 'settings.section' || node.name === 'sidebar.panellist') && node.label === undefined) {
              throw new Error(node.name + ' entry without a label')
            }
            seats.push([node.id, Component, node])
            return () => {}
          },
          inject(name, fn) {
            return fn()
          },
        }
      }
      if (serviceName === 'styles') return { insert: () => () => {} }
      return null
    },
    provide() {},
    effect(fn) {
      fn()
    },
    on() {},
  }
  moduleExports.apply(ctx)
  assert.deepEqual(seats.map(([, , node]) => node.name), ['settings.section', 'sidebar.panellist', 'main', 'shell.overlay'])
  assert.equal(moduleExports.inject.includes('slots'), true, 'the client sandbox only exposes declared services')
  const sidebarRow = seats[1][2]
  assert.equal(sidebarRow.label(), '宠物乐园')
  const mainPanel = seats[2][2]
  assert.equal(mainPanel.key, 'petmarket', 'the main panel must answer the sidebar row id')
  const settingsOptions = seats[0][2]
  assert.equal(settingsOptions.name, 'settings.section')
  assert.equal(typeof settingsOptions.label, 'function', 'a settings.section row needs a label or the nav entry renders blank')
  assert.equal(settingsOptions.label(), '宠物乐园')

  // Walk the element tree and evaluate every function component once, so a
  // render-time crash surfaces here instead of in the browser console.
  const seen = []
  const walk = (node, depth = 0) => {
    if (node == null || node === false || node === true || depth > 80) return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') return
    const children = node.children || []
    if (typeof node.type === 'function') {
      seen.push(node.type.name || 'Anonymous')
      walk(node.type(node.props || {}), depth + 1)
    }
    for (const child of children) walk(child, depth + 1)
    if (node.props && node.props.children) walk(node.props.children, depth + 1)
  }
  for (const [id, Component] of seats) {
    assert.equal(typeof Component, 'function', id + ' seat is a component')
    walk(fakeReact.createElement(Component, { ctx }))
  }
  assert.ok(seen.length >= 2, 'both seats rendered nested components: ' + seen.join(','))
})



test('the market panel opens a pet page with contract, actions, and rename', async () => {
  const source = readFileSync(join(HERE, '..', 'client.js'), 'utf8')
  let spec = null
  const fakeWindow = {
    __ModuleLoader__: { load(value) { spec = value } },
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  }
  const fakeDocument = { baseURI: 'http://127.0.0.1:54438/', addEventListener() {}, removeEventListener() {} }
  // Re-rendering needs hook state that survives between calls: the panel keeps
  // the opened pet id in useState, and the detail page only exists after a click.
  const values = []
  let slot = 0
  const fakeReact = {
    useState(init) {
      const index = slot++
      if (!(index in values)) values[index] = typeof init === 'function' ? init() : init
      return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
    },
    useEffect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanup()
    },
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
  }
  const posts = []
  const catalog = {
    installed: [
      {
        petId: 'pixel-cat',
        active: true,
        activeVersion: '1.1.0',
        sourceRef: 'local:demo',
        versions: [
          {
            version: '1.1.0',
            state: 'installed',
            bytes: 5048,
            sha256: 'abc123',
            dir: 'C:\\pets\\pixel-cat\\1.1.0',
            profile: 'sprite-sequence/v1',
            installedAt: '2026-10-27T07:00:00.000Z',
            manifest: {
              name: 'Pixel Cat',
              description: 'CC0 pixel cat',
              author: 'Shepardskin',
              license: 'CC0-1.0',
              engines: { petRuntime: '^1' },
              menus: [{ id: 'nap', label: '打个盹', kind: 'action', action: 'pose:idle' }],
              reactions: { 'tool.start': { pose: 'walk' } },
              renderer: {
                type: 'sprite',
                mode: 'sheet',
                frame: { w: 40, h: 34 },
                sheet: { cols: 6, rows: 3, margin: 0, spacing: 0 },
                animations: {
                  idle: { row: 0, from: 0, frames: 2, fps: 6, loop: true },
                  run: { row: 2, from: 0, frames: 6, fps: 14, loop: false, next: 'idle' },
                },
                states: { idle: 'idle', happy: 'run' },
              },
            },
          },
        ],
      },
    ],
    sources: [],
    jobs: [],
    ui: { positions: {}, names: {}, active: 'pixel-cat' },
    desktop: { available: true, pets: 1 },
    runtime: { mode: 'local' },
    storage: { mode: 'fs', dataRoot: 'C:\\pets' },
  }
  const fetchStub = async (url, init) => {
    const target = String(url)
    if (init && init.method === 'POST') posts.push([target, init.body ? JSON.parse(init.body) : null])
    const value = target.includes('jobs') ? { jobs: [] } : catalog
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value }) }
  }
  const factory = new Function('window', 'document', 'EventSource', 'fetch', source)
  factory(fakeWindow, fakeDocument, class { addEventListener() {} close() {} }, fetchStub)
  const moduleExports = spec.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const seats = []
  moduleExports.apply({
    get(serviceName) {
      if (serviceName === 'slots') {
        return { register(node, Component) { seats.push([node.id, Component, node]); return () => {} }, inject(name, fn) { return fn() } }
      }
      if (serviceName === 'styles') return { insert: () => () => {} }
      return null
    },
    provide() {},
    effect(fn) { fn() },
    on() {},
  })
  const Panel = seats.find(([, , node]) => node.name === 'settings.section')[1]
  const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
  const render = () => {
    slot = 0
    return Panel({})
  }
  render()
  await settle()
  const first = render()
  const collect = (node, out = []) => {
    if (node == null || typeof node === 'string' || typeof node === 'number' || node === false) return out
    if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
    if (typeof node.type === 'function') {
      // Evaluate the child component so the detail page's own hook state and
      // markup show up in the collected tree.
      out.push(node)
      collect(node.type(node.props || {}), out)
      return out
    }
    out.push(node)
    for (const child of node.children || []) collect(child, out)
    if (node.props && node.props.children) collect(node.props.children, out)
    return out
  }
  const nodes = collect(first)
  const openDetail = nodes.find((node) => node.type === 'button' && (node.children || []).includes('看看它'))
  assert.ok(openDetail, 'the installed row opens the pet page')
  openDetail.props.onClick()

  // Second render: the panel is now on the detail page.
  const nodes2 = collect(render())
  const texts = nodes2.filter((node) => typeof node.type === 'string').map((node) => [node.type, (node.children || []).filter((c) => typeof c === 'string').join('')])
  const has = (needle) => texts.some(([, text]) => text.includes(needle))
  assert.ok(has('它会什么'), 'detail page shows the contract card')
  assert.ok(has('动作'), 'detail page shows the action list')
  assert.ok(has('它从哪来'), 'detail page shows provenance')
  assert.ok(has('右键它能做什么'), 'detail page shows the right-click menu')
  const previews = nodes2.filter((node) => node.props && node.props.className === 'pmk-anim-name')
  const animNames = previews.map((node) => (node.children || []).join(''))
  assert.ok(animNames.includes('run') && animNames.includes('idle'), 'each action renders its own frame preview')
  const loops = nodes2
    .filter((node) => node.props && node.props.className === 'pmk-meta')
    .map((node) => (node.children || []).filter((c) => typeof c === 'string').join(''))
  assert.ok(loops.some((text) => text.includes('播一次')), 'the one-shot action says it plays once')

  const input = nodes2.find((node) => node.type === 'input' && node.props && typeof node.props.placeholder === 'string' && node.props.placeholder.includes('名字'))
  assert.ok(input, 'the rename input exists')
  input.props.onChange({ target: { value: '小黑' } })
  const nodes3 = collect(render())
  const save = nodes3.find((node) => node.type === 'button' && (node.children || []).includes('叫这个名字'))
  assert.ok(save, 'the rename button exists')
  save.props.onClick()
  const rename = posts.find(([target]) => target.includes('/state'))
  assert.ok(rename, 'renaming posts to the state endpoint')
  assert.equal(rename[1].name, '小黑')
})

test('desktop stage: state payload, hit test, and window lifecycle', async () => {
  const { buildStageState, hitTest, createDesktopStage } = await import('../lib/desktop-stage.js')
  const dir = join(HERE, '..', 'demo', 'packs', 'pixel-cat')
  const renderer = {
    type: 'sprite',
    mode: 'sheet',
    frame: { w: 40, h: 34 },
    image: 'animations/cat.png',
    sheet: { width: 240, height: 102, margin: 0, spacing: 0 },
    animations: { idle: { row: 0, from: 0, frames: 2, fps: 4, loop: true }, walk: { row: 1, from: 0, frames: 6, fps: 12, loop: true } },
    states: { idle: 'idle', walk: 'walk' },
  }
  const installed = [
    {
      petId: 'pixel-cat',
      active: true,
      activeVersion: '1.0.0',
      versions: [{ version: '1.0.0', state: 'installed', dir, renderer }],
    },
    { petId: 'sleepy', active: false, activeVersion: '1.0.0', versions: [{ version: '1.0.0', state: 'installed', dir, renderer }] },
  ]
  const state = buildStageState({ installed, ui: { positions: {}, active: 'pixel-cat' }, bounds: { width: 1280, height: 720 } })
  assert.equal(state.pets.length, 1, 'only the active pack reaches the desktop')
  const pet = state.pets[0]
  assert.ok(pet.image.startsWith('data:image/png;base64,'), 'sprite sheet is inlined for the sandboxed page')
  assert.equal(pet.pos.scale, 2, 'small frames default to 2x on the desktop')
  assert.ok(pet.pos.x + pet.frame.w * pet.pos.scale <= 1280)
  assert.ok(pet.pos.y + pet.frame.h * pet.pos.scale <= 720)
  assert.equal(hitTest(state.pets, { x: pet.pos.x + 4, y: pet.pos.y + 4 }), 'pixel-cat')
  assert.equal(hitTest(state.pets, { x: pet.pos.x - 20, y: pet.pos.y - 20 }), null)

  const saved = buildStageState({ installed, ui: { positions: { 'pixel-cat': { x: 100, y: 120, facing: -1 } } }, bounds: { width: 1280, height: 720 } })
  assert.deepEqual([saved.pets[0].pos.x, saved.pets[0].pos.y, saved.pets[0].pos.facing], [100, 120, -1])

  const headless = createDesktopStage({ store: { list: () => installed }, router: { readUi: () => ({ positions: {}, active: null }) }, config: {} })
  const skipped = await headless.attach()
  assert.equal(skipped.available, false)
  assert.equal(skipped.reason, 'not-electron-main')
  headless.dispose()

  // Fake Electron: the adapter must create one transparent always-on-top window,
  // wire the IPC channels, and tear everything down in dispose().
  const created = []
  const listeners = new Map()
  const winEvents = new Map()
  const ipc = { on: (name, fn) => listeners.set(name, fn), removeAllListeners: (name) => listeners.delete(name) }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1600, height: 900 } }
  const fakeElectron = {
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: 10, y: 10 }), on: () => {} },
    ipcMain: ipc,
    BrowserWindow: class {
      constructor(options) {
        created.push(options)
        this.options = options
        this.destroyed = false
        this.webContents = { send: () => {}, on: () => {}, setWindowOpenHandler: () => {} }
      }
      isDestroyed() {
        return this.destroyed
      }
      setAlwaysOnTop() {}
      setSkipTaskbar() {}
      setIgnoreMouseEvents() {}
      setBounds() {}
      showInactive() {}
      loadFile() {
        return Promise.resolve()
      }
      once(name, fn) {
        winEvents.set(name, fn)
      }
      on(name, fn) {
        winEvents.set(name, fn)
      }
      removeAllListeners() {}
      destroy() {
        this.destroyed = true
      }
    },
  }
  const writes = []
  const stage = createDesktopStage({
    store: { list: () => installed },
    router: { readUi: () => ({ positions: {}, active: 'pixel-cat' }), writeUi: (next) => writes.push(next), broadcast: () => {}, subscribe: () => () => {} },
    config: {},
    loadElectron: () => Promise.resolve(fakeElectron),
    isElectronMain: () => true,
  })
  const attached = await stage.attach()
  assert.equal(attached.available, true)
  assert.equal(created.length, 1, 'exactly one stage window')
  assert.equal(created[0].transparent, true)
  assert.equal(created[0].frame, false)
  assert.equal(created[0].alwaysOnTop, true)
  assert.equal(created[0].focusable, false)
  assert.equal(created[0].skipTaskbar, true)
  assert.equal(stage.status().pets, 1)
  assert.ok(listeners.has('petmarket:persist'), 'drag persistence is wired')
  listeners.get('petmarket:persist')(null, { petId: 'pixel-cat', position: { x: 64, y: 72, facing: -1 } })
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].positions['pixel-cat'], { x: 64, y: 72, scale: undefined, facing: -1 })
  stage.dispose()
  assert.equal(stage.status().window, false)
  assert.equal(listeners.size, 0)
})

test('desktop stage page: renders, animates, drags, and persists', async () => {
  const listenersByType = new Map()
  class El {
    constructor(tag) {
      this.tag = tag
      this.children = []
      this.style = {}
      this.dataset = {}
      this.title = ''
      this.parent = null
      this.handlers = new Map()
    }
    appendChild(child) {
      child.parent = this
      this.children.push(child)
      return child
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this)
    }
    addEventListener(type, fn) {
      const list = this.handlers.get(type) || []
      list.push(fn)
      this.handlers.set(type, list)
    }
    setPointerCapture() {}
    releasePointerCapture() {}
    fire(type, payload) {
      for (const fn of this.handlers.get(type) || []) fn(payload)
    }
  }
  const stage = new El('div')
  const body = new El('body')
  let rafQueue = []
  const bridgeState = { persist: [] }
  globalThis.window = {
    petStage: {
      onState: (cb) => listenersByType.set('state', cb),
      ready: () => listenersByType.set('ready', true),
      persist: (petId, pos) => bridgeState.persist.push({ petId, pos }),
    },
    addEventListener: () => {},
    innerWidth: 1600,
    innerHeight: 900,
  }
  globalThis.document = {
    getElementById: (id) => (id === 'stage' ? stage : null),
    createElement: (tag) => new El(tag),
    body,
  }
  globalThis.requestAnimationFrame = (fn) => {
    rafQueue.push(fn)
    return rafQueue.length
  }
  await import('../stage/stage.js?probe=' + Date.now())
  const pushState = listenersByType.get('state')
  assert.equal(typeof pushState, 'function', 'stage page subscribes to the host')
  assert.equal(listenersByType.get('ready'), true, 'stage page announces itself')

  const pet = {
    petId: 'pixel-cat',
    version: '1.0.0',
    name: 'Pixel Cat',
    frame: { w: 40, h: 34 },
    sheet: { width: 240, height: 102, margin: 0, spacing: 0, cols: 6, rows: 3 },
    animations: { idle: { row: 0, from: 0, frames: 2, fps: 10, loop: true }, walk: { row: 1, from: 0, frames: 6, fps: 10, loop: true } },
    states: { idle: 'idle', walk: 'walk' },
    image: 'data:image/png;base64,AAAA',
    pos: { x: 100, y: 120, scale: 2, facing: 1 },
  }
  pushState({ bounds: { width: 1600, height: 900 }, pets: [pet] })
  assert.equal(stage.children.length, 1, 'one element per active pet')
  const node = stage.children[0]
  assert.equal(node.style.width, '80px')
  assert.equal(node.style.height, '68px')
  assert.match(node.style.transform, /translate3d\(100px,120px,0\)/)
  assert.match(node.style.backgroundPosition, /0px 0px/)

  const run = (ms) => {
    const queue = rafQueue
    rafQueue = []
    for (const fn of queue) fn(ms)
  }
  run(performance.now() + 120)
  assert.notEqual(node.style.backgroundPosition, '0px 0px', 'frames advance on the desktop stage')

  const savedPos = JSON.parse(JSON.stringify(pet.pos))
  node.fire('pointerdown', { screenX: 100, screenY: 120, pointerId: 1, preventDefault() {} })
  node.fire('pointermove', { screenX: 160, screenY: 150, pointerId: 1 })
  node.fire('pointerup', { screenX: 160, screenY: 150, pointerId: 1 })
  assert.equal(bridgeState.persist.length, 1, 'drag release reports the new position')
  assert.equal(bridgeState.persist[0].petId, 'pixel-cat')
  assert.equal(bridgeState.persist[0].pos.x, savedPos.x + 60)
  assert.equal(bridgeState.persist[0].pos.y, savedPos.y + 30)

  node.fire('pointerdown', { screenX: 0, screenY: 0, pointerId: 2, preventDefault() {} })
  node.fire('pointerup', { screenX: 0, screenY: 0, pointerId: 2 })
  assert.equal(bridgeState.persist.length, 1, 'a click does not persist a position')

  pushState({ bounds: { width: 1600, height: 900 }, pets: [] })
  assert.equal(stage.children.length, 0, 'removing the pet removes its element')
})



test('wpf stage: builds desktop payload and spawns one painter process', async () => {
  const { buildWpfState, createWpfStage, stageCommand } = await import('../lib/desktop-stage-wpf.js')
  const repoRoot = join(HERE, '..')
  const root = tempRoot()
  const packDir = join(root, 'pack')
  const state = buildWpfState({
    installed: [
      {
        petId: 'pixel-cat',
        active: true,
        activeVersion: '1.0.0',
        state: 'installed',
        versions: [
          {
            version: '1.0.0',
            dir: 'C:\\packs\\pixel-cat\\1.0.0',
            manifest: {
              name: 'Pixel Cat',
              renderer: {
                type: 'sprite',
                mode: 'sheet',
                image: 'animations/cat.png',
                frame: { w: 40, h: 34 },
                sheet: { width: 240, height: 102, cols: 6, rows: 3, margin: 0, spacing: 0 },
                animations: { idle: { row: 0, from: 0, frames: 2, fps: 3, loop: true } },
                states: { idle: 'idle', walk: 'walk' },
              },
            },
          },
        ],
      },
      { petId: 'sleeper', active: false, state: 'installed', versions: [] },
    ],
    ui: { positions: { 'pixel-cat': { x: 120, y: 240, facing: -1 } } },
  })
  assert.equal(state.pets.length, 1, 'only the active pet reaches the desktop')
  const stale = buildWpfState({
    installed: [
      {
        petId: 'pixel-cat',
        active: false,
        activeVersion: '1.0.0',
        versions: [{ version: '1.0.0', state: 'disabled', dir: 'C:\\packs\\pixel-cat\\1.0.0', manifest: { renderer: { type: 'sprite', frame: { w: 40, h: 34 }, image: 'animations/cat.png', sheet: {}, animations: {} } } }],
      },
    ],
    ui: { active: 'pixel-cat', positions: {} },
  })
  assert.equal(stale.pets.length, 0, 'an explicit ledger disable outranks a stale ui.active')
  const silent = buildWpfState({
    installed: [
      {
        petId: 'pixel-cat',
        activeVersion: '1.0.0',
        versions: [{ version: '1.0.0', state: 'installed', dir: 'C:\\packs\\pixel-cat\\1.0.0', manifest: { renderer: { type: 'sprite', frame: { w: 40, h: 34 }, image: 'animations/cat.png', sheet: {}, animations: {} } } }],
      },
    ],
    ui: { active: 'pixel-cat', positions: {} },
  })
  assert.equal(silent.pets.length, 1, 'a ledger without an active flag falls back to ui.active')
  const pet = state.pets[0]
  assert.equal(pet.petId, 'pixel-cat')
  assert.equal(pet.image, join('C:\\packs\\pixel-cat\\1.0.0', 'animations/cat.png'))
  assert.equal(pet.pos.x, 120)
  assert.equal(pet.pos.facing, -1)
  assert.equal(pet.pos.scale, 4, 'a 40px frame defaults to 4x')
  assert.equal(pet.animations.idle.loop, true)

  const calls = []
  const fakeChild = { pid: 4242, on() {}, unref() {}, kill() { calls.push(['kill']) } }
  const stage = createWpfStage({
    store: { root, list: () => [], paths: { cache: root } },
    router: { readUi: () => ({ positions: {}, active: null }), writeUi() {}, broadcast() {} },
    logger: null,
    pluginRoot: repoRoot,
    getPort: () => 54438,
    platform: 'win32',
    powershellPath: 'powershell.exe',
    fileExists: () => true,
    spawn: (file, args, options) => {
      calls.push([file, args, options])
      return fakeChild
    },
  })
  const attached = await stage.attach()
  assert.equal(attached.available, true, 'the wpf stage starts when powershell exists')
  const spawnCall = calls.find((entry) => Array.isArray(entry[1]))
  assert.ok(spawnCall, 'a painter process is spawned')
  assert.match(spawnCall[0], /powershell(\.exe)?$/i)
  const command = spawnCall[1].join(' ')
  assert.match(command, /-State/)
  assert.match(command, /-Port 54438/)
  assert.match(command, /-Token/)
  assert.equal(stage.status().engine, 'wpf')
  assert.equal(stage.status().available, true)
  stage.dispose()
  assert.deepEqual(calls.filter((entry) => entry[0] === 'kill').length, 1, 'dispose stops the painter')
})

test('wpf stage: the painter script keeps its handlers in script scope', async () => {
  // A menu handler wrapped in GetNewClosure runs in a fresh module scope where
  // Post-StageJson / Set-Pose / Write-StageLog do not exist. The first click
  // then threw CommandNotFoundException inside a WPF callback and killed the
  // painter, which read on screen as "every pet vanished for a few seconds".
  const source = readFileSync(join(HERE, '..', 'stage', 'desktop-pet.ps1'), 'utf8')
  assert.equal(source.includes('GetNewClosure'), false, 'menu handlers must not use GetNewClosure')
  assert.match(source, /add_UnhandledException/, 'patcher callbacks must be guarded')
  assert.match(source, /\.Tag = \$pet/, 'menu items carry their pet on Tag')
})

test('wpf stage: a painter that quits is respawned with backoff', async () => {
  const { createWpfStage } = await import('../lib/desktop-stage-wpf.js')
  const repoRoot = join(HERE, '..')
  const root = tempRoot()
  const timers = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, delay) => {
    timers.push([fn, delay])
    return { unref() {} }
  }
  try {
    const handlers = {}
    let spawns = 0
    const child = {
      pid: 5150,
      on(event, fn) {
        handlers[event] = fn
      },
      unref() {},
      kill() {},
    }
    const stage = createWpfStage({
      store: { root, list: () => [], paths: { cache: root } },
      router: { readUi: () => ({ positions: {}, active: null }), writeUi() {}, broadcast() {} },
      logger: null,
      pluginRoot: repoRoot,
      getPort: () => 54438,
      platform: 'win32',
      powershellPath: 'powershell.exe',
      fileExists: () => true,
      spawn: () => {
        spawns += 1
        return child
      },
    })
    await stage.attach()
    assert.equal(spawns, 1)
    handlers.exit(1)
    assert.equal(stage.status().reason, 'exited')
    const retry = timers.find(([, delay]) => delay > 0)
    assert.ok(retry, 'an exited painter schedules a retry')
    assert.equal(retry[1], 1500, 'the first retry is quick')
    retry[0]()
    assert.equal(spawns, 2, 'the retry spawns a fresh painter')
    stage.dispose()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('wpf stage: position posts prove themselves with the stage token', async () => {
  const { createRouter } = await import('../lib/router.js')
  const host = fakeHost()
  const store = openStore({ dataRoot: tempRoot() })
  const runtime = (await import('../lib/runtime.js')).createRuntimeBridge(fakeCtx({ pethost: host }), null)
  const router = createRouter({
    store,
    runtime,
    logger: null,
    getInstaller: () => ({ activate: async () => ({}), disable: async () => ({}), uninstall: async () => ({}), rollback: async () => ({}) }),
    getStageToken: () => 'stage-token-123',
  })
  try {
    const denied = fakeRes()
    await router.handler(fakeReq('POST', '/petmarket/api/stage/position', { body: { petId: 'pixel-cat', x: 10, y: 20 } }), denied)
    assert.equal(denied.statusCode, 403, 'no token, no write')

    const accepted = fakeRes()
    await router.handler(
      fakeReq('POST', '/petmarket/api/stage/position', {
        body: { petId: 'pixel-cat', x: 10, y: 20, facing: -1 },
        headers: { 'x-petmarket-stage': 'stage-token-123' },
      }),
      accepted,
    )
    assert.equal(accepted.statusCode, 200)
    assert.equal(accepted.body().value.positions['pixel-cat'].x, 10)
    assert.equal(store.mode, 'fs')

    // Renaming goes through the same state endpoint and lands in ui.names,
    // which the painter reads as the pet's display name.
    const renamed = fakeRes()
    await router.handler(
      fakeReq('POST', '/petmarket/api/installed/pixel-cat/state', { body: { name: '  小黑  ' } }),
      renamed,
    )
    assert.equal(renamed.statusCode, 200)
    assert.equal(renamed.body().value.name, '小黑', 'the alias is trimmed and returned')
    assert.equal(router.readUi().names['pixel-cat'], '小黑')
    const cleared = fakeRes()
    await router.handler(fakeReq('POST', '/petmarket/api/installed/pixel-cat/state', { body: { name: '   ' } }), cleared)
    assert.equal(cleared.body().value.name, null, 'an empty alias falls back to the pack name')
    assert.equal(router.readUi().names['pixel-cat'], undefined)

    // Plate colour and font family share one record per pet, so the painter can
    // read a single object instead of three parallel maps.
    const styled = fakeRes()
    await router.handler(
      fakeReq('POST', '/petmarket/api/installed/pixel-cat/state', {
        body: { nameFont: 22, nameColor: '#ffd166', nameFamily: 'Consolas' },
      }),
      styled,
    )
    assert.equal(styled.statusCode, 200)
    assert.deepEqual(router.readUi().nameStyles['pixel-cat'], { size: 22, color: '#ffd166', family: 'Consolas' })
    assert.equal(styled.body().value.nameStyle.color, '#ffd166')
    const badColor = fakeRes()
    await router.handler(
      fakeReq('POST', '/petmarket/api/installed/pixel-cat/state', { body: { nameColor: 'red' } }),
      badColor,
    )
    assert.equal(badColor.statusCode, 200, 'a non-hex colour is ignored, not fatal')
    assert.equal(router.readUi().nameStyles['pixel-cat'].color, '#ffd166')

    // The right-click menu is allowed to act: bed time maps onto disable().
    let slept = null
    const sleeping = createRouter({
      store,
      runtime,
      logger: null,
      getInstaller: () => ({ activate: async () => ({}), disable: (id) => { slept = id; return { petId: id } }, uninstall: async () => ({}) }),
      getStageToken: () => 'stage-token-123',
    })
    const sleepRes = fakeRes()
    await sleeping.handler(
      fakeReq('POST', '/petmarket/api/stage/click', {
        body: { petId: 'pixel-cat', action: 'sleep' },
        headers: { 'x-petmarket-stage': 'stage-token-123' },
      }),
      sleepRes,
    )
    assert.equal(sleepRes.statusCode, 200)
    assert.equal(slept, 'pixel-cat', 'sleep disables the pet through the installer')
    sleeping.dispose()
  } finally {
    router.dispose()
    rmSync(store.root, { recursive: true, force: true })
  }
})

test('wpf stage: the alias from ui.names reaches the desktop payload', async () => {
  const { buildWpfState } = await import('../lib/desktop-stage-wpf.js')
  const dir = join(HERE, '..', 'demo', 'packs', 'pixel-cat')
  const renderer = {
    type: 'sprite',
    mode: 'sheet',
    frame: { w: 40, h: 34 },
    image: 'animations/cat.png',
    sheet: { cols: 6, rows: 3, margin: 0, spacing: 0 },
    animations: { idle: { row: 0, from: 0, frames: 2, fps: 6, loop: true } },
    states: { idle: 'idle' },
  }
  const installed = [
    {
      petId: 'pixel-cat',
      active: true,
      activeVersion: '1.0.0',
      versions: [{ version: '1.0.0', state: 'installed', dir, manifest: { name: 'Pixel Cat', renderer } }],
    },
  ]
  const plain = buildWpfState({ installed, ui: { positions: {}, names: {}, active: 'pixel-cat' } })
  assert.equal(plain.pets[0].name, 'Pixel Cat')
  const aliased = buildWpfState({ installed, ui: { positions: {}, names: { 'pixel-cat': '小黑' }, active: 'pixel-cat' } })
  assert.equal(aliased.pets[0].name, '小黑')
})
