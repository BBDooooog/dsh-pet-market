// Standalone smoke test for the desktop stage: run with
//   "DeepSeek Harness.exe" test/electron-stage-smoke.cjs
// It builds the real transparent window from lib/desktop-stage.js, waits for a
// frame, captures a PNG, and writes a JSON report next to it.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const OUT = process.env.PM_STAGE_OUT || path.join(process.env.TEMP || '.', 'pm-stage-report.json')
const PNG = process.env.PM_STAGE_PNG || path.join(process.env.TEMP || '.', 'pm-stage-shot.png')
const report = { logs: [], steps: [] }

function save() {
  try {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  } catch (err) {
    /* nothing else to do */
  }
}

function log(level) {
  return (...args) => {
    report.logs.push(level + ': ' + args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' '))
  }
}

app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const repo = path.resolve(__dirname, '..')
  try {
    const mod = await import(pathToFileURL(path.join(repo, 'lib', 'desktop-stage.js')).href)
    const dir = path.join(repo, 'demo', 'packs', 'pixel-cat')
    const renderer = {
      type: 'sprite',
      mode: 'sheet',
      frame: { w: 40, h: 34 },
      image: 'animations/cat.png',
      sheet: { width: 240, height: 102, margin: 0, spacing: 0, cols: 6, rows: 3 },
      animations: {
        idle: { row: 0, from: 0, frames: 2, fps: 4, loop: true, hold: null, next: null, direction: 'forward' },
        walk: { row: 1, from: 0, frames: 6, fps: 12, loop: true, hold: null, next: null, direction: 'forward' },
        happy: { row: 2, from: 0, frames: 6, fps: 12, loop: false, hold: null, next: 'idle', direction: 'forward' },
      },
      states: { idle: 'idle', walk: 'walk', happy: 'happy' },
      flip: true,
    }
    const installed = [
      {
        petId: 'pixel-cat',
        active: true,
        activeVersion: '1.0.0',
        versions: [{ version: '1.0.0', state: 'installed', dir, renderer, manifest: { name: 'Pixel Cat' } }],
      },
    ]
    const stage = mod.createDesktopStage({
      store: { list: () => installed },
      router: {
        readUi: () => ({ positions: { 'pixel-cat': { x: 620, y: 420 } }, active: 'pixel-cat' }),
        writeUi: () => {},
        broadcast: () => {},
        subscribe: () => () => {},
      },
      logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      config: {},
    })
    const attached = await stage.attach()
    report.steps.push({ attach: attached })
    report.status = stage.status()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const win = BrowserWindow.getAllWindows()[0]
    report.windows = BrowserWindow.getAllWindows().length
    if (win) {
      report.bounds = win.getBounds()
      report.alwaysOnTop = win.isAlwaysOnTop()
      const image = await win.capturePage()
      const png = image.toPNG()
      fs.writeFileSync(PNG, png)
      report.png = { path: PNG, bytes: png.length, size: image.getSize() }
      const probe = await win.webContents.executeJavaScript(
        'JSON.stringify({ pets: document.querySelectorAll(".pet").length, body: document.body.innerText.slice(0, 200) })',
      )
      report.probe = probe
    }
    stage.dispose()
    report.steps.push({ disposed: true })
  } catch (err) {
    report.error = String((err && err.stack) || err)
  }
  save()
  app.exit(0)
})

setTimeout(() => {
  report.timeout = true
  save()
  app.exit(1)
}, 25000)
