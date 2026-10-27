// @dsh-pet-market — Host half.
// The market is a distribution pipe: it resolves a source, downloads one asset,
// proves the package is legal and runnable, commits it under a data root, and
// hands a descriptor to whichever pet host is around.

import { MarketError, loggerOf } from './lib/util.js'
import { openStore } from './lib/ledger.js'
import { createRuntimeBridge } from './lib/runtime.js'
import { createInstaller } from './lib/install.js'
import { createRouter } from './lib/router.js'
import { createDesktopStage } from './lib/desktop-stage.js'
import { createWpfStage } from './lib/desktop-stage-wpf.js'
import { parseSource } from './lib/sources.js'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url))

export const name = 'petmarket'
// The HTTP surface is the market's only entry point, so webServer is a declared
// inject: cordis parks the plugin until the provider exists, and the DSH sandbox
// facade allows the property read only for declared services.
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const logger = loggerOf(ctx)

  ctx.effect(() => {
    let store
    try {
      store = openStore({ dataRoot: config.dataRoot })
    } catch (err) {
      logger.error('cannot open market storage; market stays disabled', err && err.message ? err.message : err)
      return () => {}
    }

    const runtime = createRuntimeBridge(ctx, logger)
    const settings = {
      keepVersions: Number(config.keepVersions || store.config.keepVersions || 1),
      allowPrerelease: config.allowPrerelease === true || store.config.allowPrerelease === true,
      allowDowngrade: config.allowDowngrade === true,
    }
    let stage = null
    const router = createRouter({
      store,
      runtime,
      logger,
      getInstaller: () => installer,
      getDesktop: () => (stage ? stage.status() : null),
      getStageToken: () => (stage && stage.token ? stage.token : null),
    })
    const installer = createInstaller({
      store,
      runtime,
      config: settings,
      logger,
      events: { broadcast: (type, data) => router.broadcast(type, data) },
    })

    const attached = router.attach(ctx)
    if (!attached.available) {
      logger.warn('web server unavailable; market API is not exposed (' + attached.reason + ')')
    }

    // The desktop stage puts pets on the OS desktop. DSH Desktop runs the plugin
    // host with ELECTRON_RUN_AS_NODE=1, so there is no BrowserWindow here: on
    // Windows the pets are painted by a small WPF process instead. A real
    // Electron main process (when the host happens to be one) keeps the native
    // window path.
    const portOf = () => {
      try {
        const web = ctx.get('webServer')
        return web && Number(web.port) ? Number(web.port) : 0
      } catch {
        return 0
      }
    }
    stage = createDesktopStage({ store, router, logger, config })
    stage
      .attach()
      .then((result) => {
        if (result && result.available) {
          logger.info('desktop stage ready (electron): ' + result.bounds.width + 'x' + result.bounds.height)
          return result
        }
        if (config.desktop === false) return result
        const fallback = createWpfStage({ store, router, logger, config, pluginRoot: PLUGIN_ROOT, getPort: portOf })
        return fallback.attach().then((wpf) => {
          if (wpf && wpf.available) {
            stage = fallback
            logger.info('desktop stage ready (wpf): ' + fallback.statePath)
          } else {
            logger.info('desktop stage not started: ' + (wpf ? wpf.reason : 'unknown'))
          }
          return wpf
        })
      })
      .catch((err) => logger.warn('desktop stage failed: ' + (err && err.message ? err.message : String(err))))

    // Installed/activated changes must reach the desktop stage; the SSE listeners
    // already exist, so reuse them instead of polling the ledger.
    const unsubscribe = router.subscribe((type) => {
      if (!stage) return
      if (type === 'installed.changed' || type === 'sources.changed' || type === 'catalog.changed') {
        try {
          stage.refresh()
        } catch {
          // stage refresh is best effort
        }
      }
    })

    logger.info(
      'petmarket ready: mode=' + runtime.mode + ' storage=' + store.mode + ' root=' + store.root + (store.degraded ? ' (' + store.degraded + ')' : ''),
    )

    if (typeof ctx.provide === 'function') {
      try {
        ctx.provide('petmarket', {
          version: '0.1.0',
          mode: runtime.mode,
          dataRoot: store.root,
          install: (source) => {
            const parsed = parseSource(source)
            const kind =
              parsed.kind === 'local'
                ? /\.(dsppet|zip)$/i.test(parsed.path)
                  ? 'local-file'
                  : 'local-dir'
                : 'github'
            return installer.enqueue({
              kind,
              sourceRef: parsed.sourceRef,
              input: parsed.kind === 'local' ? parsed.path : null,
            })
          },
          list: () => store.list(),
          jobs: () => installer.listJobs(),
          activate: (petId, version) => installer.activate(petId, version),
          disable: (petId) => installer.disable(petId),
          uninstall: (petId, version) => installer.uninstall(petId, version),
          snapshot: () => router.snapshot(),
          desktop: () => (stage ? stage.status() : null),
          refreshDesktop: () => {
            if (stage) stage.refresh()
          },
        })
      } catch {
        // another scope already provided it
      }
    }

    return () => {
      try {
        unsubscribe()
      } catch {
        // ignore
      }
      if (stage) {
        try {
          stage.dispose()
        } catch {
          // ignore
        }
      }
      try {
        router.dispose()
      } catch {
        // ignore
      }
      store.log('info', 'petmarket stopped')
    }
  })
}

export { MarketError }
