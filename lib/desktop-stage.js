// Desktop stage: a transparent, click-through, always-on-top window owned by the
// DSH host process. It puts the same sprite packs on the operating system
// desktop instead of only inside the DSH web page.
//
// Two halves live here:
//   * pure helpers (buildStageState / hitTest / petRects) — no Electron, unit tested
//   * createDesktopStage — thin Electron adapter, created only inside the Electron
//     main process (`process.type === 'browser'`)
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requireFromHere = createRequire(import.meta.url)

// ELECTRON_RUN_AS_NODE makes `import('electron')` hand back a path string, so the
// loader is tried twice before the stage gives up.
async function defaultLoadElectron() {
  try {
    const loaded = await import('electron')
    if (loaded && loaded.BrowserWindow) return loaded
  } catch {
    /* fall through to createRequire */
  }
  try {
    const loaded = requireFromHere('electron')
    if (loaded && loaded.BrowserWindow) return loaded
  } catch {
    /* not running inside Electron */
  }
  return null
}

const STAGE_HTML = fileURLToPath(new URL('../stage/stage.html', import.meta.url))
const PRELOAD = fileURLToPath(new URL('../stage/preload.cjs', import.meta.url))

function imageDataUrl(dir, relPath, cache) {
  const full = resolve(dir, relPath)
  if (!full.startsWith(resolve(dir))) return null
  if (!existsSync(full)) return null
  const key = full
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const bytes = readFileSync(full)
    const lower = full.toLowerCase()
    const mime = lower.endsWith('.webp') ? 'image/webp' : lower.endsWith('.gif') ? 'image/gif' : 'image/png'
    const url = 'data:' + mime + ';base64,' + bytes.toString('base64')
    cache.set(key, url)
    return url
  } catch {
    return null
  }
}

// Picks the sprite sheet of every active pack and turns it into one serialisable
// payload for the stage page. Positions come from ui.json so the web overlay and
// the desktop window share one source of truth.
export function buildStageState({ installed, ui, bounds, cache = new Map() }) {
  const positions = (ui && ui.positions) || {}
  const pets = []
  for (const record of Array.isArray(installed) ? installed : []) {
    if (!record || record.active !== true) continue
    const versions = Array.isArray(record.versions) ? record.versions : []
    const entry = versions.find((item) => item && item.version === record.activeVersion) || versions[0]
    if (!entry || !entry.renderer || entry.renderer.type !== 'sprite') continue
    if (entry.state && entry.state !== 'installed' && entry.state !== 'pending-restart') continue
    const renderer = entry.renderer
    const frame = renderer.frame || { w: 32, h: 32 }
    const saved = positions[record.petId] || {}
    const scale = Number(saved.scale) > 0 ? Number(saved.scale) : frame.w <= 64 ? 2 : 1
    const facing = Number(saved.facing) === -1 ? -1 : 1
    let image = null
    if (renderer.mode === 'sheet' && entry.dir && renderer.image) {
      image = imageDataUrl(entry.dir, renderer.image, cache)
    }
    if (!image) continue
    const maxX = Math.max(0, (bounds.width || 0) - frame.w * scale)
    const maxY = Math.max(0, (bounds.height || 0) - frame.h * scale)
    const x = Number.isFinite(saved.x) ? Math.min(Math.max(saved.x, 0), maxX) : Math.max(0, maxX - 24)
    const y = Number.isFinite(saved.y) ? Math.min(Math.max(saved.y, 0), maxY) : Math.max(0, maxY - 24)
    pets.push({
      petId: record.petId,
      version: entry.version,
      name: (entry.manifest && entry.manifest.name) || record.petId,
      frame: { w: frame.w, h: frame.h },
      sheet: renderer.sheet || { width: frame.w, height: frame.h, margin: 0, spacing: 0 },
      animations: renderer.animations || {},
      states: renderer.states || { idle: 'idle' },
      image,
      pos: { x, y, scale, facing },
    })
  }
  return { bounds: { width: bounds.width || 0, height: bounds.height || 0 }, pets }
}

export function petRects(pets) {
  return (Array.isArray(pets) ? pets : []).map((pet) => {
    const frame = pet.frame || { w: 32, h: 32 }
    const scale = Number(pet.pos && pet.pos.scale) || 1
    return {
      petId: pet.petId,
      x: pet.pos.x,
      y: pet.pos.y,
      width: frame.w * scale,
      height: frame.h * scale,
    }
  })
}

export function hitTest(pets, point) {
  if (!point) return null
  for (const rect of petRects(pets)) {
    if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) {
      return rect.petId
    }
  }
  return null
}

export function createDesktopStage({ store, router, logger, config = {}, loadElectron, isElectronMain }) {
  const settings = config && typeof config === 'object' ? config : {}
  const electronMain =
    typeof isElectronMain === 'function'
      ? isElectronMain()
      : typeof process !== 'undefined' &&
        !!(process.versions && process.versions.electron) &&
        process.type !== 'renderer' &&
        process.type !== 'worker'
  const cache = new Map()
  const state = { available: false, reason: 'not-started', window: false, pets: 0, attachedAt: null }
  let electron = null
  let win = null
  let poll = null
  let unsubscribe = null
  let ignoring = true
  let dragActive = false
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  let currentPets = []

  function log(level, message, detail) {
    try {
      if (logger && typeof logger[level] === 'function') logger[level]('desktop: ' + message, detail)
    } catch {
      /* logging never breaks the stage */
    }
  }

  function computeState() {
    const installed = typeof store.list === 'function' ? store.list() : []
    const ui = typeof router.readUi === 'function' ? router.readUi() : { positions: {}, active: null }
    const state_ = buildStageState({ installed, ui, bounds: { width: bounds.width, height: bounds.height }, cache })
    currentPets = state_.pets
    return state_
  }

  function push() {
    if (!win || win.isDestroyed()) return
    const payload = computeState()
    state.pets = payload.pets.length
    try {
      win.webContents.send('petmarket:state', payload)
    } catch (err) {
      log('warn', 'cannot push stage state', err && err.message)
    }
  }

  function refresh() {
    push()
  }

  function applyBounds(display) {
    const area = display && display.bounds ? display.bounds : { x: 0, y: 0, width: 1280, height: 720 }
    bounds = { x: area.x, y: area.y, width: area.width, height: area.height }
    if (win && !win.isDestroyed()) {
      win.setBounds(bounds)
      push()
    }
  }

  function hitTestCursor() {
    if (!win || win.isDestroyed() || !electron) return
    if (dragActive) return
    let cursor
    try {
      cursor = electron.screen.getCursorScreenPoint()
    } catch {
      return
    }
    const local = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    const over = hitTest(currentPets, local) !== null
    if (over && ignoring) {
      ignoring = false
      win.setIgnoreMouseEvents(false)
    } else if (!over && !ignoring) {
      ignoring = true
      win.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  function persist(petId, position) {
    if (!petId || !position || typeof position !== 'object') return
    try {
      const ui = router.readUi()
      const positions = { ...(ui.positions || {}) }
      positions[petId] = {
        x: Math.round(Number(position.x) || 0),
        y: Math.round(Number(position.y) || 0),
        scale: Number(position.scale) > 0 ? Number(position.scale) : undefined,
        facing: Number(position.facing) === -1 ? -1 : 1,
      }
      const next = { ...ui, positions }
      router.writeUi(next)
      // Tell the web overlay too, so both surfaces agree immediately.
      router.broadcast('installed.changed', { petId, positions: next.positions })
    } catch (err) {
      log('warn', 'cannot persist position', err && err.message)
    }
  }

  async function attach() {
    if (settings.desktop === false) {
      state.reason = 'disabled'
      return { available: false, reason: 'disabled' }
    }
    if (!electronMain) {
      state.reason = 'not-electron-main'
      return { available: false, reason: 'not-electron-main' }
    }
    try {
      electron = typeof loadElectron === 'function' ? await loadElectron() : await defaultLoadElectron()
    } catch (err) {
      state.reason = 'electron-unavailable'
      log('warn', 'cannot load electron', err && err.message)
      return { available: false, reason: 'electron-unavailable' }
    }
    if (!electron || !electron.BrowserWindow) {
      state.reason = 'electron-unavailable'
      return { available: false, reason: 'electron-unavailable' }
    }
    try {
      const displays = electron.screen.getAllDisplays()
      const index = Number.isInteger(settings.displayIndex) ? settings.displayIndex : 0
      const display = displays[index] || electron.screen.getPrimaryDisplay()
      applyBounds(display)
      win = new electron.BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        show: false,
        acceptFirstMouse: true,
        alwaysOnTop: true,
        webPreferences: {
          preload: PRELOAD,
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
          devTools: false,
        },
      })
      win.setAlwaysOnTop(true, settings.alwaysOnTopLevel || 'floating')
      win.setSkipTaskbar(true)
      win.setIgnoreMouseEvents(true, { forward: true })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('will-navigate', (event) => event.preventDefault())
      win.webContents.on('render-process-gone', (_event, detail) => {
        state.reason = 'renderer-gone'
        log('warn', 'stage renderer gone', detail && detail.reason)
      })
      win.once('ready-to-show', () => {
        if (!win || win.isDestroyed()) return
        win.showInactive()
        push()
      })
      win.on('closed', () => {
        win = null
        state.window = false
        state.reason = 'window-closed'
      })
      await win.loadFile(STAGE_HTML)

      electron.ipcMain.on('petmarket:ready', push)
      electron.ipcMain.on('petmarket:dragging', (_event, active) => {
        dragActive = active === true
        if (dragActive && win && !win.isDestroyed()) {
          ignoring = false
          win.setIgnoreMouseEvents(false)
        }
        if (!dragActive) hitTestCursor()
      })
      electron.ipcMain.on('petmarket:persist', (_event, payload) => {
        if (payload && payload.petId) persist(payload.petId, payload.position)
        push()
      })
      electron.ipcMain.on('petmarket:open-market', () => {
        log('info', 'open-market requested from stage')
      })

      if (typeof router.subscribe === 'function') unsubscribe = router.subscribe(() => push())
      poll = setInterval(hitTestCursor, 90)
      if (poll && typeof poll.unref === 'function') poll.unref()
      if (electron.screen && typeof electron.screen.on === 'function') {
        electron.screen.on('display-metrics-changed', () => applyBounds(electron.screen.getPrimaryDisplay()))
        electron.screen.on('display-removed', () => applyBounds(electron.screen.getPrimaryDisplay()))
        electron.screen.on('display-added', () => applyBounds(electron.screen.getPrimaryDisplay()))
      }
      state.available = true
      state.window = true
      state.reason = 'ready'
      state.attachedAt = new Date().toISOString()
      log('info', 'stage ready', { bounds, display: display && display.id })
      push()
      return { available: true, bounds }
    } catch (err) {
      state.available = false
      state.reason = 'stage-failed'
      log('warn', 'cannot create stage window', err && err.message)
      dispose()
      return { available: false, reason: 'stage-failed', message: err && err.message }
    }
  }

  function dispose() {
    if (poll) {
      clearInterval(poll)
      poll = null
    }
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        /* already gone */
      }
      unsubscribe = null
    }
    if (electron && electron.ipcMain) {
      electron.ipcMain.removeAllListeners('petmarket:ready')
      electron.ipcMain.removeAllListeners('petmarket:persist')
      electron.ipcMain.removeAllListeners('petmarket:dragging')
      electron.ipcMain.removeAllListeners('petmarket:open-market')
    }
    if (win && !win.isDestroyed()) {
      try {
        win.removeAllListeners()
        win.destroy()
      } catch {
        /* already gone */
      }
    }
    win = null
    state.window = false
    if (state.available) state.reason = 'disposed'
    state.available = false
    cache.clear()
  }

  function status() {
    return {
      available: state.available,
      reason: state.reason,
      window: state.window,
      pets: state.pets,
      bounds: { width: bounds.width, height: bounds.height },
      attachedAt: state.attachedAt,
    }
  }

  return { attach, dispose, refresh, push, status, persist, hitTest: (point) => hitTest(currentPets, point) }
}

export const STAGE_FILES = { html: STAGE_HTML, preload: PRELOAD }
