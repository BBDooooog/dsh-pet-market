import { spawn as spawnProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nowIso } from './util.js'

const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

export const STAGE_SCRIPT = join('stage', 'desktop-pet.ps1')

function psQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}

/**
 * Windows PowerShell 5.1 refuses to run the script with `-File` on hosts whose
 * execution policy rejects unsigned files (the DSH profile hits
 * "AuthorizationManager check failed"). Reading the file into a script block
 * sidesteps that check while keeping the same script.
 */
export function stageCommand(scriptPath, statePath, port, token, owner = 0) {
  return (
    '$ErrorActionPreference = "Stop"; ' +
    '$sb = [scriptblock]::Create([IO.File]::ReadAllText(' +
    psQuote(scriptPath) +
    ')); & $sb -State ' +
    psQuote(statePath) +
    ' -Port ' +
    String(port) +
    ' -Token ' +
    psQuote(token) +
    ' -Owner ' +
    String(Number(owner) || 0)
  )
}

function defaultScale(frame) {
  // Pixel sprites are unreadable at 1x on a 2K desktop. Small frames get a
  // bigger default so a freshly installed pet shows up at a usable size.
  const w = frame && Number(frame.w) > 0 ? Number(frame.w) : 128
  if (w <= 32) return 5
  if (w <= 64) return 4
  if (w <= 128) return 2
  return 1
}

/**
 * The ledger stores the renderer snapshot taken when the pack was installed, so
 * packs installed before `renderer.front` existed keep saying nothing and a
 * left-facing sprite walks backwards. pet.json on disk is the current truth:
 * read `front` from there and patch it into the snapshot.
 */
function withDiskFront(renderer, dir) {
  if (!renderer || renderer.type !== 'sprite') return renderer
  if (renderer.front === 'left' || renderer.front === 'right') return renderer
  if (!dir) return renderer
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8'))
    const front = manifest && manifest.renderer && manifest.renderer.front
    if (front === 'left' || front === 'right') return { ...renderer, front }
  } catch {
    // A missing or half-written pet.json just means "keep the old snapshot".
  }
  return renderer
}

/**
 * Turn the ledger + ui.json into the payload the PowerShell stage paints.
 * Every image path is absolute, because the child process has no idea where the
 * plugin file is; atlases only change on install, so this stays cheap.
 */
export function buildWpfState({ installed = [], ui = {}, now = null } = {}) {
  const positions = (ui && ui.positions) || {}
  // ui.json and the ledger both claim to know which pet is on the desktop. The
  // ledger wins, but a stale ledger (older builds only wrote ui.json) must not
  // leave the panel saying "on the desktop" while the desktop stays empty.
  const uiActive = ui && typeof ui.active === 'string' ? ui.active : null
  const pets = []
  let slot = 0
  for (const record of installed) {
    if (!record) continue
    const ledgerSilent = record.active !== true && record.active !== false
    const active = record.active === true || (ledgerSilent && uiActive !== null && record.petId === uiActive)
    if (!active) continue
    const version = record.activeVersion
    if (!version) continue
    const entry = (record.versions || []).find((item) => item && item.version === version)
    if (!entry) continue
    const state = entry.state || record.state
    if (state !== 'installed' && state !== 'pending-restart') continue
    const ledgerRenderer = entry && entry.manifest && entry.manifest.renderer
    const dir = entry.dir || (record.dir ? record.dir : null)
    const renderer = withDiskFront(ledgerRenderer, dir)
    if (!renderer || renderer.type !== 'sprite') continue
    if (!dir) continue
    const frame = renderer.frame || { w: 128, h: 128 }
    const saved = positions[record.petId] || {}
    const scale = Number(saved.scale) > 0 ? Number(saved.scale) : defaultScale(frame)
    const sheet = renderer.sheet || { width: 0, height: 0, cols: 1, rows: 1, margin: 0, spacing: 0 }
    const animations = {}
    for (const [name, anim] of Object.entries(renderer.animations || {})) {
      if (!anim) continue
      animations[name] = {
        row: Number(anim.row) || 0,
        from: Number(anim.from) || 0,
        frames: Math.max(1, Number(anim.frames) || 1),
        fps: Math.max(1, Number(anim.fps) || 8),
        loop: anim.loop !== false,
        next: typeof anim.next === 'string' ? anim.next : null,
      }
    }
    const states = {}
    for (const [pose, name] of Object.entries(renderer.states || {})) {
      if (typeof name === 'string') states[pose] = name
    }
    const image = renderer.image ? join(dir, renderer.image) : null
    const files = Array.isArray(renderer.files)
      ? renderer.files.map((rel) => join(dir, rel))
      : Array.isArray(renderer.animations && renderer.animations.idle && renderer.animations.idle.files)
        ? renderer.animations.idle.files.map((rel) => join(dir, rel))
        : []
    const alias = (ui && ui.names && ui.names[record.petId]) || (entry.manifest && entry.manifest.name) || record.petId
    const frameW = Number(frame.w) || 128
    const frameH = Number(frame.h) || 128
    const style = (ui && ui.nameStyles && ui.nameStyles[record.petId]) || {}
    const askedFont = Number(style.size) || Number(ui && ui.nameFonts ? ui.nameFonts[record.petId] : NaN)
    // The label rides along with the sprite, so its size follows the zoom
    // unless the owner picked an explicit size on the detail page.
    const nameFont = Number.isFinite(askedFont) && askedFont >= 8 && askedFont <= 72 ? Math.round(askedFont) : Math.max(10, Math.round(frameH * scale * 0.14))
    pets.push({
      petId: record.petId,
      name: alias,
      nameFont,
      // Colour + family travel with the label; the painter falls back to the
      // dark plate and system font when the owner has not picked any.
      nameColor: typeof style.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(style.color) ? style.color : null,
      nameFamily: typeof style.family === 'string' && style.family.trim() ? style.family.trim().slice(0, 40) : null,
      // Which way the artwork itself faces. The painter mirrors only when the
      // requested facing disagrees with the drawing, otherwise a left-facing
      // sheet walks backwards.
      front: renderer.front === 'left' ? 'left' : 'right',
      menus: Array.isArray(entry.manifest && entry.manifest.menus) ? entry.manifest.menus : [],
      mode: renderer.mode === 'frames' ? 'frames' : 'sheet',
      image,
      files,
      frame: { w: frameW, h: frameH },
      sheet: {
        cols: Number(sheet.cols) || 1,
        rows: Number(sheet.rows) || 1,
        margin: Number(sheet.margin) || 0,
        spacing: Number(sheet.spacing) || 0,
      },
      animations,
      states,
      pos: {
        x: Number.isFinite(saved.x) ? Math.round(saved.x) : null,
        y: Number.isFinite(saved.y) ? Math.round(saved.y) : null,
        scale,
        facing: Number(saved.facing) === -1 ? -1 : 1,
        // Pets without a saved position fan out along the bottom-right corner
        // instead of stacking on top of each other.
        slot: Number.isFinite(saved.x) && Number.isFinite(saved.y) ? null : slot++,
      },
    })
  }
  return { revision: now || nowIso(), pets }
}

function ensureToken(root) {
  const file = join(root, 'stage', 'token')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
  } catch {
    /* fall through and mint a new one */
  }
  const token = randomBytes(24).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
  } catch {
    /* an unwritable root still works for this process lifetime */
  }
  return token
}

/**
 * Desktop stage for hosts that are not a real Electron main process, which is
 * what DSH Desktop ships: the plugin host runs with ELECTRON_RUN_AS_NODE=1 and
 * has no BrowserWindow. Windows still gets a real desktop pet through a small
 * WPF process: transparent, always-on-top, one window per pet.
 */
export function createWpfStage({
  store,
  router,
  logger,
  config = {},
  pluginRoot,
  getPort,
  spawn = spawnProcess,
  now = () => Date.now(),
  // Injected so the stage can be unit tested from a non-Windows CI runner: the
  // real defaults are the host platform, the bundled powershell path, and fs.
  platform = process.platform,
  powershellPath = POWERSHELL,
  fileExists = existsSync,
} = {}) {
  const statePath = join(store.root, 'stage', 'state.json')
  const scriptPath = join(pluginRoot || process.cwd(), STAGE_SCRIPT)
  const token = ensureToken(store.root)
  let child = null
  let startedAt = null
  let lastReason = 'not-started'
  let lastWrite = 0
  let lastPayload = ''
  let retryTimer = null
  let stateTimer = null
  let attempts = 0
  let spawnedAtMs = 0
  let disposed = false
  const errLog = join(dirname(statePath), 'stage.err.log')

  function log(level, message, detail) {
    if (logger && typeof logger[level] === 'function') logger[level](message, detail)
  }

  function readPort() {
    if (typeof getPort === 'function') {
      try {
        const port = getPort()
        if (Number.isFinite(port) && port > 0) return Number(port)
      } catch {
        /* fall through */
      }
    }
    return 0
  }

  function payload() {
    return buildWpfState({ installed: (store && store.list()) || [], ui: (router && router.readUi()) || {} })
  }

  function writeState(force = false) {
    const next = payload()
    const wire = JSON.stringify(next, null, 2)
    if (!force && wire === lastPayload) return false
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      // Windows refuses rename-over-open-file (the painter reads this file every
      // 500 ms), so write in place. A torn read only makes the painter keep its
      // previous frame: it parses the text and ignores a malformed payload.
      writeFileSync(statePath, wire, 'utf8')
      lastPayload = wire
      lastWrite = now()
      if (child && lastReason === 'state-write-failed') lastReason = 'running'
      return true
    } catch (err) {
      lastReason = child ? 'running' : 'state-write-failed'
      log('warn', 'desktop stage: state write failed: ' + err.message)
      if (!stateTimer && !disposed) {
        stateTimer = setTimeout(() => {
          stateTimer = null
          writeState(true)
        }, 250)
        stateTimer.unref?.()
      }
      return false
    }
  }

  function cleanupStale() {
    const pidFile = join(dirname(statePath), 'stage.pid')
    try {
      if (!existsSync(pidFile)) return
      const record = JSON.parse(readFileSync(pidFile, 'utf8'))
      const pid = record && Number(record.pid)
      const owner = record && Number(record.owner)
      if (!Number.isFinite(pid) || pid === process.pid) return
      if (child && pid === child.pid) return
      // A painter owned by a live *other* host belongs to that host: two DSH
      // windows on the same data root would otherwise keep killing each other's
      // stage. Only our own leftovers and orphans get reaped.
      if (Number.isFinite(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) return
      try {
        process.kill(pid)
        log('info', 'desktop stage: stopped a stale painter process ' + String(pid))
      } catch {
        // already gone
      }
    } catch {
      // a malformed pid file only means nothing to clean
    }
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function scheduleRetry() {
    if (disposed || config.desktop === false) return
    if (retryTimer) return
    attempts += 1
    const delay = Math.min(30000, 1500 * attempts)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (disposed) return
      refresh()
    }, delay)
    retryTimer.unref?.()
  }

  function spawnStage() {
    if (disposed) return false
    if (child) return true
    const port = readPort()
    if (!port) {
      lastReason = 'port-unavailable'
      return false
    }
    if (!fileExists(scriptPath)) {
      lastReason = 'script-missing'
      return false
    }
    if (!fileExists(powershellPath)) {
      lastReason = 'powershell-missing'
      return false
    }
    writeState(true)
    cleanupStale()
    try {
      child = spawn(
        powershellPath,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', stageCommand(scriptPath, statePath, port, token, process.pid)],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          try {
            appendFileSync(errLog, String(chunk))
          } catch {
            /* best effort */
          }
        })
      }
      child.on('exit', (code) => {
        log('info', 'desktop stage exited: ' + String(code))
        child = null
        startedAt = null
        lastReason = 'exited'
        // A painter that lived for a while and then quit is a fresh problem, not a
        // crash loop; only an instant exit keeps escalating the backoff.
        if (spawnedAtMs && Date.now() - spawnedAtMs > 10000) attempts = 0
        scheduleRetry()
      })
      child.on('error', (err) => {
        log('warn', 'desktop stage spawn failed: ' + err.message)
        child = null
        lastReason = 'spawn-failed'
        scheduleRetry()
      })
      child.unref()
      startedAt = nowIso()
      spawnedAtMs = Date.now()
      lastReason = 'running'
      return true
    } catch (err) {
      lastReason = 'spawn-failed'
      log('warn', 'desktop stage spawn failed: ' + err.message)
      scheduleRetry()
      return false
    }
  }

  async function attach() {
    if (config.desktop === false) {
      lastReason = 'disabled'
      return { available: false, reason: lastReason }
    }
    if (platform !== 'win32') {
      lastReason = 'platform-unsupported'
      return { available: false, reason: lastReason }
    }
    const ok = spawnStage()
    return { available: ok, reason: lastReason }
  }

  function refresh() {
    const changed = writeState()
    if (!child && (changed || lastReason === 'exited' || lastReason === 'not-started')) spawnStage()
    return status()
  }
  function persist(petId, position) {
    if (!petId || !position) return false
    const ui = router.readUi()
    ui.positions = { ...(ui.positions || {}), [petId]: { ...(ui.positions && ui.positions[petId]), ...position } }
    router.writeUi(ui)
    router.broadcast('installed.changed', { petId, positions: ui.positions })
    refresh()
    return true
  }

  function status() {
    const pets = (() => {
      try {
        return JSON.parse(lastPayload || '{}').pets || []
      } catch {
        return []
      }
    })()
    return {
      available: Boolean(child),
      engine: 'wpf',
      reason: lastReason,
      pid: child ? child.pid : null,
      pets: pets.length,
      attachedAt: startedAt,
      token: undefined,
    }
  }

  function dispose() {
    disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (stateTimer) {
      clearTimeout(stateTimer)
      stateTimer = null
    }
    if (child) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      child = null
    }
    startedAt = null
    lastReason = 'disposed'
  }

  return {
    attach,
    dispose,
    refresh,
    push: () => refresh(),
    persist,
    status,
    token,
    statePath,
    scriptPath,
    get state() {
      return lastPayload
    },
    get lastWrite() {
      return lastWrite
    },
  }
}

