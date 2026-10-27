// @dsh-pet-market — Client half. Single file, no build step.
// Two seats: a settings panel that drives installs, and an overlay stage that
// draws whichever sprite pet the host currently runs.

window.__ModuleLoader__.load({
  id: 'dsh-pet-market',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = 'petmarket/api/'
    const SETTINGS_ID = 'petmarket.market'
    const OVERLAY_ID = 'petmarket.stage'
    const PANEL_ID = 'petmarket'

    const services = { slots: null, styles: null, timer: null, locale: null }

    const CSS = `
.pmk-root{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#0f172a)}
.pmk-card{border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:11px;padding:12px 13px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02));display:flex;flex-direction:column;gap:10px}
.pmk-title{font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#64748b);text-transform:uppercase}
.pmk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pmk-input{flex:1 1 220px;min-width:160px;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16));background:var(--dsw-alias-bg-base,transparent);color:inherit;font-size:12.5px;font-family:inherit}
.pmk-btn{padding:5px 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16));background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04));color:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.pmk-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-btn:disabled{opacity:.45;cursor:default}
.pmk-btn[data-tone="primary"]{border-color:var(--dsw-alias-brand-primary,#4c6ce0);color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-btn[data-tone="danger"]:hover{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
.pmk-drop{border:1.5px dashed var(--dsw-alias-border-l2,rgba(15,23,42,.22));border-radius:11px;padding:16px 12px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#64748b);transition:border-color .15s,background .15s}
.pmk-drop[data-over="true"]{border-color:var(--dsw-alias-brand-primary,#4c6ce0);background:rgba(76,108,224,.07)}
.pmk-packs{display:flex;flex-direction:column;gap:8px}
.pmk-pack{display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.12));border-radius:10px;transition:border-color .12s,background .12s}
.pmk-pack[data-active="true"]{background:rgba(76,108,224,.05)}
.pmk-pack:hover{border-color:var(--dsw-alias-brand-primary,#4c6ce0);background:rgba(76,108,224,.09)}
.pmk-thumb{width:38px;height:38px;border-radius:8px;object-fit:contain;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04));image-rendering:pixelated}
.pmk-pack-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.pmk-pack-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmk-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pmk-badge{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16));color:var(--dsw-alias-label-secondary,#64748b)}
.pmk-badge[data-state="installed"]{border-color:var(--dsw-alias-brand-primary,#4c6ce0);color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-badge[data-state="broken"]{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
.pmk-badge[data-state="pending-restart"]{border-color:var(--dsw-alias-state-warn-primary,#f5a524);color:var(--dsw-alias-state-warn-primary,#f5a524)}
.pmk-jobs{display:flex;flex-direction:column;gap:7px}
.pmk-job{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1))}
.pmk-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.1));overflow:hidden}
.pmk-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#4c6ce0);transition:width .2s}
.pmk-err{padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;white-space:pre-wrap}
.pmk-note{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#64748b)}
.pmk-stage{position:fixed;inset:0;pointer-events:none;z-index:1150;contain:layout paint style}
.pmk-anchor{position:absolute;left:0;top:0;will-change:transform}
.pmk-pet{pointer-events:auto;cursor:grab;user-select:none;touch-action:none;filter:drop-shadow(0 8px 14px rgba(15,23,42,.18));image-rendering:pixelated;background-repeat:no-repeat}
.pmk-pet[data-dragging="true"]{cursor:grabbing;filter:drop-shadow(0 14px 22px rgba(15,23,42,.24))}
.pmk-empty{position:fixed;right:16px;bottom:16px;pointer-events:none;font-size:11.5px;color:var(--dsw-alias-label-secondary,#64748b)}
.pmk-root{max-width:760px}
.pmk-head{display:flex;align-items:baseline;gap:10px;padding:0 2px}
.pmk-head-title{font-size:15px;font-weight:650;letter-spacing:.01em}
.pmk-head-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#64748b)}
.pmk-btn-icon{width:26px;padding:4px 0;text-align:center;font-size:14px;line-height:1}
.pmk-scale{font-size:11px;min-width:26px;text-align:center;color:var(--dsw-alias-label-secondary,#64748b);font-variant-numeric:tabular-nums}
.pmk-pack:hover{border-color:var(--dsw-alias-brand-primary,#4c6ce0);background:rgba(76,108,224,.09)}.pmk-thumb{width:44px;height:44px;padding:3px}
.pmk-drop:hover{border-color:var(--dsw-alias-border-l2,rgba(15,23,42,.32));background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.03))}
.pmk-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#64748b);line-height:1.55}
.pmk-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(15,23,42,.1));margin:2px 0}
.pmk-pack-name[data-link="true"]{cursor:pointer;text-decoration:underline;text-decoration-color:rgba(15,23,42,.22);text-underline-offset:3px}
.pmk-pack-name[data-link="true"]:hover{color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-detail{display:flex;flex-direction:column;gap:10px}
.pmk-detail-head{display:flex;gap:12px;align-items:center}
.pmk-detail-title{font-size:15px;font-weight:650}
.pmk-kv{display:grid;grid-template-columns:132px 1fr;gap:4px 10px;font-size:12px}
.pmk-kv-key{color:var(--dsw-alias-label-secondary,#64748b)}
.pmk-kv-val{min-width:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.pmk-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.pmk-table th{text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary,#64748b);padding:3px 8px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1))}
.pmk-table td{padding:3px 8px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.06))}
.pmk-table tr:last-child td{border-bottom:none}
.pmk-chip{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.16));font-size:11px;margin:0 4px 4px 0}
.pmk-back{padding:3px 8px;font-size:12px}
.pmk-scroll{max-height:calc(100vh - 190px);overflow-y:auto;overflow-x:hidden;padding-right:6px;display:flex;flex-direction:column;gap:14px}
.pmk-name-input{width:100%;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:13px;padding:1px 4px;border-radius:6px;min-width:0}
.pmk-name-input:hover{border-color:var(--dsw-alias-border-l1,rgba(15,23,42,.16))}
.pmk-name-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c6ce0);background:var(--dsw-alias-bg-base,transparent)}
.pmk-anim{display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.07))}
.pmk-anim:last-child{border-bottom:none}
.pmk-anim-frame{width:96px;height:82px;flex:0 0 auto;background-repeat:no-repeat;image-rendering:pixelated;background-color:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.04));border-radius:8px}
.pmk-anim-name{font-size:12.5px;font-weight:600}
.pmk-range{width:130px;accent-color:var(--dsw-alias-brand-primary,#4c6ce0)}
.pmk-name-row{display:flex;align-items:center;gap:6px;min-width:0}
.pmk-icon-btn{border:1px solid transparent;background:transparent;color:inherit;opacity:.55;font-size:12px;line-height:1;padding:2px 5px;border-radius:6px;cursor:pointer}
.pmk-icon-btn:hover{opacity:1;border-color:var(--dsw-alias-border-l1,rgba(15,23,42,.18));background:var(--dsw-alias-bg-layer-2,rgba(15,23,42,.05))}
.pmk-color{width:34px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.18));border-radius:6px;background:transparent;cursor:pointer}
.pmk-select{width:auto;min-width:140px;padding:3px 6px;font-size:12.5px}
`

    function svc(ctx, name) {
      try {
        return ctx.get(name) || null
      } catch (err) {
        return null
      }
    }

    // `styles.insert` exists on some hosts and silently does nothing on others.
    // Owning the <style> element keeps the panel styled everywhere; the service
    // is still tried first so the host can track it if it wants to.
    function installStyles(styles) {
      let disposeService = null
      try {
        if (styles && typeof styles.insert === 'function') {
          const handle = styles.insert(CSS)
          if (typeof handle === 'function') disposeService = handle
        }
      } catch (err) {
        console.warn('[petmarket] styles.insert unavailable: ' + (err && err.message ? err.message : err))
      }
      let tag = null
      try {
        const existing = document.querySelector('style[data-plugin="dsh-pet-market"]')
        if (existing) {
          existing.textContent = CSS
          tag = existing
        } else {
          tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-pet-market'
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
      } catch (err) {
        console.warn('[petmarket] style tag failed: ' + (err && err.message ? err.message : err))
      }
      return () => {
        try {
          if (typeof disposeService === 'function') disposeService()
        } catch (err) {
          /* the host owned it; nothing to undo */
        }
        try {
          if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
        } catch (err) {
          /* already gone */
        }
      }
    }

    // Copy lives here, not in the components, so the wording is part of the
    // plugin's own vocabulary: a pet app should read like a household, not like
    // a package manager.
    const WORDS = {
      panelTitle: '宠物乐园',
      panelSub: '带一只回家，它会一直陪着你',
      installAction: '带一只回家',
      installedTitle: '家里的宠物',
      empty: '家里还没有宠物。上面粘 owner/repo 或 release 链接，或者把素材包拖进来。',
      awake: '出来玩',
      asleep: '回窝睡觉',
      detail: '看看它',
      remove: '挥手告别',
      removeConfirm: '真的要告别吗？素材包会从本地删掉，随时可以再带回来。',
      rename: '改名',
      renameHint: '点铅笔改名，回车确认',
      back: '← 回到宠物列表',
      namePlaceholder: '给它起个名字（留空就用包里的名字）',
      saveName: '叫这个名字',
      fontLabel: '名字字号',
      fontAuto: '自动',
      colorLabel: '名字底色',
      fontFamilyLabel: '名字字体',
      contract: '它会什么',
      actions: '动作',
      statesTitle: '什么时候做什么',
      menusTitle: '右键它能做什么',
      reactionsTitle: '它会对这些有反应',
      sourceTitle: '它从哪来',
    }

    // A short list of families that ship with Windows: a free-text field would
    // let a typo silently fall back to the default without telling anyone.
    const FONT_CHOICES = ['Microsoft YaHei UI', 'Microsoft YaHei', 'SimSun', 'Segoe UI', 'Consolas', 'Comic Sans MS']

    function scaleFor(frame) {
      const w = frame && Number(frame.w) > 0 ? Number(frame.w) : 128
      if (w <= 32) return 5
      if (w <= 64) return 4
      if (w <= 128) return 2
      return 1
    }

    function urlFor(path) {
      const clean = String(path == null ? '' : path).replace(/^\/+/, '')
      try {
        return new URL(clean, document.baseURI).pathname
      } catch (err) {
        return '/' + clean
      }
    }

    function parseEnvelope(text, status) {
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch (err) {
        payload = null
      }
      if (!payload || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error : null
        const failure = new Error(detail && detail.message ? detail.message : 'HTTP ' + status)
        failure.code = detail && detail.code ? detail.code : 'http-' + status
        failure.detail = detail
        throw failure
      }
      return payload.value
    }

    // 404 means the host half is not mounted in this process yet: the page was
    // already open when the plugin was installed, so DSH still runs the old
    // composition. Say that plainly instead of leaking "http-404".
    function friendlyError(err) {
      const code = err && err.code ? String(err.code) : ''
      const message = err && err.message ? String(err.message) : '未知错误'
      if (code === 'http-404' || code === 'http-405') {
        return '后端未加载：DSH 尚未加载 petmarket 插件。重启 DSH 后再打开这个页面。'
      }
      if (code === 'http-401' || code === 'http-403') {
        return '请求被拒绝（' + code + '）：页面与会话不同源，或 token 已失效。'
      }
      if (code === 'http-500') {
        return '后端异常：' + message
      }
      return (code ? code + ': ' : '') + message
    }

    function request(method, path, body) {
      const init = { method, credentials: 'same-origin', headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      return fetch(urlFor(path), init).then((res) => res.text().then((text) => parseEnvelope(text, res.status)))
    }

    function upload(path, filename, buffer) {
      return fetch(urlFor(API + 'import?filename=' + encodeURIComponent(filename)), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/octet-stream' },
        body: buffer,
      }).then((res) => res.text().then((text) => parseEnvelope(text, res.status)))
    }

    function fmtBytes(n) {
      const value = Number(n) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
      return (value / 1024 / 1024).toFixed(1) + ' MiB'
    }

    function packAsset(petId, version, rel) {
      const parts = String(rel || '')
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
      return urlFor(API + 'packs/' + encodeURIComponent(petId) + '/' + encodeURIComponent(version) + '/' + parts)
    }

    // ------------------------------------------------------------ animation

    function animFor(renderer, pose) {
      if (!renderer || !renderer.animations) return null
      const name = (renderer.states && renderer.states[pose]) || pose
      if (renderer.animations[name]) return { name, anim: renderer.animations[name] }
      const idleName = renderer.states && renderer.states.idle
      if (idleName && renderer.animations[idleName]) return { name: idleName, anim: renderer.animations[idleName] }
      const first = Object.keys(renderer.animations)[0]
      return first ? { name: first, anim: renderer.animations[first] } : null
    }

    function totalFramesOf(anim) {
      if (!anim) return 0
      if (Array.isArray(anim.files)) return anim.files.length
      return Number(anim.frames) || 0
    }

    function frameOffset(renderer, anim, index) {
      const frame = renderer.frame || { w: 32, h: 32 }
      const sheet = renderer.sheet || { margin: 0, spacing: 0, cols: 1 }
      const margin = Number(sheet.margin) || 0
      const spacing = Number(sheet.spacing) || 0
      const row = Number(anim.row) || 0
      const from = Number(anim.from) || 0
      const col = from + index
      return {
        x: margin + col * (frame.w + spacing),
        y: margin + row * (frame.h + spacing),
      }
    }

    function useAnimation(renderer, pose, onFinished) {
      const [tick, setTick] = useState(0)
      const stateRef = useRef({ key: null, index: 0, started: 0, dir: 1, done: false })
      const current = animFor(renderer, pose)
      const key = current ? pose + ':' + current.name : 'none'
      const fps = current ? Math.max(1, Number(current.anim.fps) || 8) : 8
      const total = totalFramesOf(current && current.anim)
      const loop = current ? current.anim.loop !== false : true
      const pingpong = current && current.anim.direction === 'pingpong'

      useEffect(() => {
        stateRef.current = { key, index: 0, started: Date.now(), dir: 1, done: false }
        setTick((value) => value + 1)
      }, [key])

      useEffect(() => {
        if (!current || total <= 0) return undefined
        let alive = true
        let handle = null
        const step = () => {
          if (!alive) return
          const now = Date.now()
          const state = stateRef.current
          const elapsed = now - state.started
          const raw = Math.floor((elapsed * fps) / 1000)
          let index = raw
          if (pingpong && total > 1) {
            const span = total * 2 - 2
            const cycle = raw % span
            index = cycle < total ? cycle : span - cycle
          } else if (!loop && total > 0) {
            if (raw >= total) {
              if (!state.done) {
                state.done = true
                state.index = total - 1
                if (typeof onFinished === 'function') onFinished(current.name, current.anim)
              }
              setTick((value) => value + 1)
              return
            }
            index = raw
          } else {
            index = raw % total
          }
          if (index !== state.index) {
            state.index = index
            setTick((value) => value + 1)
          }
          handle = setTimeout(step, Math.max(16, Math.floor(1000 / fps / 2)))
        }
        step()
        return () => {
          alive = false
          if (handle) clearTimeout(handle)
        }
      }, [key, fps, total, loop, pingpong, current, onFinished])

      const index = Math.min(Math.max(0, stateRef.current.index), Math.max(0, total - 1))
      return { anim: current ? current.anim : null, name: current ? current.name : null, index, total, tick }
    }

    function PetSprite({ petId, version, renderer, pose, scale, onFinished }) {
      const { anim, index, tick } = useAnimation(renderer, pose, onFinished)
      const frame = (renderer && renderer.frame) || { w: 32, h: 32 }
      const width = frame.w * scale
      const height = frame.h * scale
      const style = { width, height }
      let content = null

      if (renderer && renderer.mode === 'frames' && anim && Array.isArray(anim.files) && anim.files.length) {
        content = h('img', {
          className: 'pmk-pet',
          alt: '',
          draggable: false,
          src: packAsset(petId, version, anim.files[Math.min(index, anim.files.length - 1)]),
          style: { width, height, imageRendering: 'pixelated' },
        })
      } else if (renderer && renderer.image) {
        const sheet = renderer.sheet || { width: frame.w, height: frame.h, cols: 1, margin: 0, spacing: 0 }
        const offset = anim ? frameOffset(renderer, anim, index) : { x: 0, y: 0 }
        style.backgroundImage = 'url("' + packAsset(petId, version, renderer.image) + '")'
        style.backgroundSize = sheet.width * scale + 'px ' + sheet.height * scale + 'px'
        style.backgroundPosition = -offset.x * scale + 'px ' + -offset.y * scale + 'px'
        content = h('div', { className: 'pmk-pet', 'aria-hidden': 'true', style, 'data-tick': tick })
      } else {
        content = h('div', { className: 'pmk-empty' }, '素材不完整')
      }
      return content
    }

    // ------------------------------------------------------------- overlay

    function PetStage() {
      const [state, setState] = useState({ loaded: false, installed: [], ui: { positions: {}, active: null }, error: null })
      const [dragging, setDragging] = useState(false)
      const [pose, setPose] = useState('idle')
      const dragRef = useRef(null)
      const posRef = useRef({ x: null, y: null })

      const load = useCallback(() => {
        return request('GET', API + 'catalog')
          .then((value) => setState({ loaded: true, installed: value.installed || [], ui: value.ui || { positions: {}, active: null }, desktop: value.desktop || null, error: null }))
          .catch((err) => setState((prev) => ({ ...prev, loaded: true, error: err.message })))
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const running = useMemo(() => {
        const list = state.installed || []
        const byActive = list.filter((item) => item.active && item.activeVersion)
        if (!byActive.length) return null
        const chosen = state.ui && state.ui.active ? byActive.find((item) => item.petId === state.ui.active) || byActive[0] : byActive[0]
        const entry = (chosen.versions || []).find((item) => item.version === chosen.activeVersion)
        if (!entry || !entry.manifest || !entry.manifest.renderer) return null
        return { petId: chosen.petId, version: chosen.activeVersion, renderer: entry.manifest.renderer, manifest: entry.manifest }
      }, [state])

      const pos = useMemo(() => {
        const saved = running && state.ui && state.ui.positions ? state.ui.positions[running.petId] : null
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved
        const frame = (running && running.renderer.frame) || { w: 128, h: 128 }
        // Pixel sprites are tiny at 1x; a 40px cat reads as a speck, so small
        // frames start at an integer multiple that matches the desktop stage.
        const scale = scaleFor(frame)
        return {
          x: Math.max(24, window.innerWidth - frame.w * scale - 48),
          y: Math.max(24, window.innerHeight - frame.h * scale - 96),
          scale,
          facing: 1,
        }
      }, [running, state.ui])

      useEffect(() => {
        posRef.current = { x: pos.x, y: pos.y }
      }, [pos.x, pos.y])

      const persist = useCallback(
        (next) => {
          if (!running) return
          request('POST', API + 'installed/' + encodeURIComponent(running.petId) + '/state', {
            x: Math.round(next.x),
            y: Math.round(next.y),
            scale: next.scale || 1,
            facing: next.facing || 1,
          }).catch(() => {
            /* position is cosmetic */
          })
        },
        [running],
      )

      const onPointerDown = useCallback(
        (event) => {
          if (!running) return
          event.preventDefault()
          const startX = event.clientX
          const startY = event.clientY
          const origin = { ...posRef.current }
          let moved = false
          setDragging(true)
          const move = (moveEvent) => {
            const dx = moveEvent.clientX - startX
            const dy = moveEvent.clientY - startY
            if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
            const next = { x: origin.x + dx, y: origin.y + dy }
            posRef.current = next
            setState((prev) => {
              const ui = prev.ui || { positions: {}, active: null }
              const positions = { ...(ui.positions || {}), [running.petId]: { ...(ui.positions || {})[running.petId], ...next } }
              return { ...prev, ui: { ...ui, positions } }
            })
          }
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            setDragging(false)
            if (!moved) {
              setPose('happy')
              if (services.timer && typeof services.timer.setTimeout === 'function') {
                services.timer.setTimeout(() => setPose('idle'), 1400)
              } else {
                setTimeout(() => setPose('idle'), 1400)
              }
            } else {
              persist(posRef.current)
            }
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        },
        [persist, running],
      )

      if (!running) return null
      // When the host puts pets on the real desktop, this overlay would draw a
      // second copy of the same pet inside the DSH window.
      if (state.desktop && state.desktop.available) return null
      const scale = Number(pos.scale) || 1
      const facing = Number(pos.facing) === -1 ? -1 : 1

      return h(
        'div',
        { className: 'pmk-stage' },
        h(
          'div',
          { className: 'pmk-anchor', style: { transform: 'translate3d(' + Math.round(pos.x) + 'px,' + Math.round(pos.y) + 'px,0)' } },
          h(
            'div',
            {
              'data-dragging': dragging ? 'true' : 'false',
              onPointerDown,
              title: running.manifest.name || running.petId,
              style: facing === -1 ? { transform: 'scaleX(-1)' } : undefined,
            },
            h(PetSprite, {
              petId: running.petId,
              version: running.version,
              renderer: running.renderer,
              pose,
              scale,
              onFinished: () => setPose('idle'),
            }),
          ),
        ),
      )
    }

    // ------------------------------------------------------------ settings

    function JobRow({ job }) {
      const pct = Math.round((Number(job.progress) || 0) * 100)
      const tone = job.phase === 'failed' ? 'var(--dsw-alias-state-error-primary,#e5484d)' : undefined
      return h(
        'div',
        { className: 'pmk-job' },
        h(
          'div',
          { className: 'pmk-row', style: { justifyContent: 'space-between' } },
          h('span', { className: 'pmk-meta' }, job.kind + ' · ' + String(job.sourceRef || '').slice(0, 64)),
          h('span', { className: 'pmk-meta', style: tone ? { color: tone } : undefined }, job.phase + ' ' + pct + '%'),
        ),
        h('div', { className: 'pmk-bar' }, h('div', { className: 'pmk-bar-fill', style: { width: pct + '%', background: tone } })),
        job.message ? h('div', { className: 'pmk-meta' }, job.message) : null,
      )
    }

    function kvRow(key, value) {
      return [h('div', { key: key + '-k', className: 'pmk-kv-key' }, key), h('div', { key: key + '-v', className: 'pmk-kv-val' }, value)]
    }

    // The detail page shows the animation itself, not the numbers behind it:
    // one live strip per declared action, playing at the package's own fps.
    function ActionPreview({ petId, version, renderer, name, anim, image }) {
      const frame = (renderer && renderer.frame) || { w: 40, h: 34 }
      const sheet = (renderer && renderer.sheet) || { margin: 0, spacing: 0, cols: 1 }
      const frames = Math.max(1, Number(anim && anim.frames) || (Array.isArray(anim && anim.files) ? anim.files.length : 1))
      const fps = Math.max(1, Number(anim && anim.fps) || 8)
      const row = Number(anim && anim.row) || 0
      const from = Number(anim && anim.from) || 0
      const [index, setIndex] = useState(0)
      useEffect(() => {
        setIndex(0)
        if (frames <= 1) return undefined
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          let frameId = 0
          let started = 0
          const step = (now) => {
            if (!started) started = now
            const next = Math.floor(((now - started) * fps) / 1000) % frames
            setIndex(next)
            frameId = window.requestAnimationFrame(step)
          }
          frameId = window.requestAnimationFrame(step)
          return () => window.cancelAnimationFrame(frameId)
        }
        const timer = setInterval(() => setIndex((prev) => (prev + 1) % frames), Math.round(1000 / fps))
        return () => clearInterval(timer)
      }, [frames, fps, name])
      const cellW = Number(frame.w) || 40
      const cellH = Number(frame.h) || 34
      const zoom = Math.max(1, Math.min(3, Math.floor(Math.min(96 / cellW, 82 / cellH)) || 1))
      const files = Array.isArray(anim && anim.files) ? anim.files : null
      const style = { width: cellW * zoom + 'px', height: cellH * zoom + 'px', backgroundSize: 'auto' }
      if (files && files.length) {
        style.backgroundImage = 'url(' + packAsset(petId, version, files[Math.min(index, files.length - 1)]) + ')'
        style.backgroundSize = '100% 100%'
      } else if (image) {
        const margin = Number(sheet.margin) || 0
        const spacing = Number(sheet.spacing) || 0
        const col = from + index
        const x = margin + col * (cellW + spacing)
        const y = margin + row * (cellH + spacing)
        style.backgroundImage = 'url(' + packAsset(petId, version, image) + ')'
        style.backgroundSize = cellW * (Number(sheet.cols) || 1) * zoom + 'px ' + 'auto'
        style.backgroundPosition = -x * zoom + 'px ' + -y * zoom + 'px'
      }
      return h(
        'div',
        { className: 'pmk-anim' },
        h('div', { className: 'pmk-anim-frame', style }),
        h(
          'div',
          { className: 'pmk-pack-body' },
          h('div', { className: 'pmk-anim-name' }, name),
          h('div', { className: 'pmk-meta' }, frames + ' 帧 · ' + fps + ' fps · ' + (anim && anim.loop === false ? '播一次' : '循环') + (anim && anim.next ? ' · 接 ' + anim.next : '')),
        ),
      )
    }

    // Renaming happens in the list itself, but only after the owner clicks the
    // pencil: a bare text field in every row looked like an input-heavy form.
    function NameCell({ petId, value, onSaved }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(value || '')
      const [note, setNote] = useState('')
      useEffect(() => {
        setDraft(value || '')
      }, [value])
      const commit = () => {
        const next = String(draft || '').trim()
        setEditing(false)
        if (next === String(value || '').trim()) return
        request('POST', API + 'installed/' + encodeURIComponent(petId) + '/state', { name: next })
          .then(() => {
            setNote('已改名')
            if (onSaved) onSaved()
          })
          .catch((err) => setNote(friendlyError(err)))
      }
      if (editing) {
        return h('input', {
          className: 'pmk-name-input',
          value: draft,
          autoFocus: true,
          spellCheck: false,
          placeholder: '回车确认，Esc 取消',
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(value || '')
              setEditing(false)
            }
          },
        })
      }
      return h(
        'span',
        { className: 'pmk-name-row' },
        h('span', { className: 'pmk-pack-name' }, value || petId),
        h(
          'button',
          {
            type: 'button',
            className: 'pmk-icon-btn',
            title: note || WORDS.renameHint,
            'data-action': 'rename',
            onClick: () => {
              setNote('')
              setEditing(true)
            },
          },
          '✎',
        ),
        note ? h('span', { className: 'pmk-meta' }, note) : null,
      )
    }

    function AnimTable({ renderer, petId, version, image }) {
      const animations = (renderer && renderer.animations) || {}
      const names = Object.keys(animations)
      if (!names.length) return h('div', { className: 'pmk-note' }, '这个包没有声明动画。')
      return h(
        'div',
        null,
        names.map((name) => h(ActionPreview, { key: name, petId, version, renderer, name, anim: animations[name] || {}, image })),
      )
    }

    function PetDetail({ item, catalog, onBack, onRefresh, scaleDraft }) {
      const versions = item.versions || []
      const entry = versions.find((version) => version.version === item.activeVersion) || versions[versions.length - 1] || {}
      const manifest = entry.manifest || {}
      const renderer = manifest.renderer || entry.renderer || {}
      const frame = renderer.frame || { w: 0, h: 0 }
      const sheet = renderer.sheet || null
      const names = (catalog.ui && catalog.ui.names) || {}
      const fonts = (catalog.ui && catalog.ui.nameFonts) || {}
      const [nameDraft, setNameDraft] = useState(names[item.petId] || '')
      const [saved, setSaved] = useState(null)
      const savedPos = (catalog.ui && catalog.ui.positions && catalog.ui.positions[item.petId]) || null
      const serverScale = (savedPos && Number(savedPos.scale)) || scaleFor(frame)
      const currentScale = scaleDraft[item.petId] || serverScale
      const autoFont = Math.max(10, Math.round((Number(frame.h) || 34) * currentScale * 0.14))
      const [fontDraft, setFontDraft] = useState(fonts[item.petId] || autoFont)
      const thumb = manifest.thumbnail
      const states = renderer.states || {}
      const menus = Array.isArray(manifest.menus) ? manifest.menus : []
      const reactions = manifest.reactions || {}
      const reactionKeys = Object.keys(reactions)

      const saveState = (patch, done) => {
        setSaved(null)
        request('POST', API + 'installed/' + encodeURIComponent(item.petId) + '/state', patch)
          .then(() => {
            setSaved(done || '已保存')
            if (onRefresh) onRefresh()
          })
          .catch((err) => setSaved(friendlyError(err)))
      }
      const saveName = () => saveState({ name: nameDraft }, '它现在叫这个名字')
      const saveFont = (value) => {
        setFontDraft(value)
        saveState({ nameFont: value }, '字号已存')
      }
      const styles = (catalog.ui && catalog.ui.nameStyles) || {}
      const currentStyle = styles[item.petId] || {}
      const saveStyle = (patch, done) => saveState(patch, done)

      return h(
        'div',
        { className: 'pmk-scroll' },
        h(
          'div',
          { className: 'pmk-detail' },
          h(
            'div',
            { className: 'pmk-row' },
            h('button', { type: 'button', className: 'pmk-btn pmk-back', onClick: onBack }, WORDS.back),
            h('div', { className: 'pmk-meta' }, item.petId + ' · v' + (entry.version || '?') + (entry.bytes ? ' · ' + fmtBytes(entry.bytes) : '')),
          ),
          h(
            'div',
            { className: 'pmk-card' },
            h(
              'div',
              { className: 'pmk-detail-head' },
              thumb ? h('img', { className: 'pmk-thumb', alt: '', src: packAsset(item.petId, entry.version, thumb) }) : h('div', { className: 'pmk-thumb' }),
              h(
                'div',
                { className: 'pmk-pack-body' },
                h('div', { className: 'pmk-detail-title' }, names[item.petId] || manifest.name || item.petId),
                h('div', { className: 'pmk-meta' }, manifest.description || '（包里没有写描述）'),
                h('div', { className: 'pmk-meta' }, manifest.name && names[item.petId] && names[item.petId] !== manifest.name ? '原名 ' + manifest.name : item.petId),
              ),
            ),
            h(
              'div',
              { className: 'pmk-row' },
              h('input', {
                className: 'pmk-input',
                value: nameDraft,
                placeholder: WORDS.namePlaceholder,
                spellCheck: false,
                onChange: (event) => setNameDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') saveName()
                },
              }),
              h('button', { type: 'button', className: 'pmk-btn', 'data-tone': 'primary', onClick: saveName }, WORDS.saveName),
              saved ? h('span', { className: 'pmk-meta' }, saved) : null,
            ),
            h(
              'div',
              { className: 'pmk-row' },
              h('span', { className: 'pmk-meta' }, WORDS.fontLabel),
              h('input', {
                type: 'range',
                className: 'pmk-range',
                min: 8,
                max: 48,
                step: 1,
                value: fontDraft,
                onChange: (event) => setFontDraft(Number(event.target.value)),
                onMouseUp: (event) => saveFont(Number(event.target.value)),
                onKeyUp: (event) => saveFont(Number(event.target.value)),
                onTouchEnd: (event) => saveFont(Number(event.target.value)),
              }),
              h('span', { className: 'pmk-scale' }, fontDraft + 'px'),
              h(
                'button',
                { type: 'button', className: 'pmk-btn', onClick: () => saveFont(autoFont) },
                WORDS.fontAuto + '（' + autoFont + 'px）',
              ),
            ),
            h(
              'div',
              { className: 'pmk-row' },
              h('span', { className: 'pmk-meta' }, WORDS.colorLabel),
              h('input', {
                type: 'color',
                className: 'pmk-color',
                value: currentStyle.color || '#11141a',
                title: '名字底色',
                onChange: (event) => saveStyle({ nameColor: event.target.value }, '底色已存'),
              }),
              h('span', { className: 'pmk-meta' }, WORDS.fontFamilyLabel),
              h(
                'select',
                {
                  className: 'pmk-input pmk-select',
                  value: currentStyle.family || '',
                  onChange: (event) => saveStyle({ nameFamily: event.target.value || null }, '字体已存'),
                },
                h('option', { value: '' }, '跟随系统'),
                FONT_CHOICES.map((family) => h('option', { key: family, value: family }, family)),
              ),
              saved ? h('span', { className: 'pmk-meta' }, saved) : null,
            ),
          ),
          h(
            'div',
            { className: 'pmk-card' },
            h('div', { className: 'pmk-title' }, WORDS.contract),
            h(
              'div',
              { className: 'pmk-kv' },
              kvRow('契约版本', entry.profile || manifest.profile || 'sprite-sequence/v1'),
              kvRow('需要的运行时', (manifest.engines && JSON.stringify(manifest.engines)) || 'petRuntime *'),
              kvRow('渲染方式', (renderer.type || 'sprite') + ' · ' + (renderer.mode || 'sheet')),
              kvRow('单帧尺寸', frame.w + ' × ' + frame.h + ' px'),
              kvRow('图集布局', sheet ? sheet.cols + ' 列 × ' + sheet.rows + ' 行 · 边距 ' + (sheet.margin || 0) + ' · 间隙 ' + (sheet.spacing || 0) : '逐帧文件'),
              kvRow('默认缩放', scaleFor(frame) + 'x（1–8x 可调）'),
              kvRow('动作数', String(Object.keys(renderer.animations || {}).length)),
              kvRow('对齐点', manifest.anchor ? JSON.stringify(manifest.anchor) : '0.5, 1'),
            ),
          ),
          h(
            'div',
            { className: 'pmk-card' },
            h('div', { className: 'pmk-title' }, WORDS.actions),
            h(AnimTable, { renderer, petId: item.petId, version: entry.version, image: renderer.image }),
          ),
          Object.keys(states).length
            ? h(
                'div',
                { className: 'pmk-card' },
                h('div', { className: 'pmk-title' }, WORDS.statesTitle),
                h(
                  'div',
                  null,
                  Object.keys(states).map((pose) => h('span', { key: pose, className: 'pmk-chip' }, pose + ' → ' + states[pose])),
                ),
              )
            : null,
          menus.length
            ? h(
                'div',
                { className: 'pmk-card' },
                h('div', { className: 'pmk-title' }, WORDS.menusTitle),
                h(
                  'div',
                  { className: 'pmk-kv' },
                  menus.map((menu) => kvRow(menu.label || menu.id, (menu.kind || 'action') + ' · ' + (menu.action || menu.command || menu.url || ''))),
                ),
              )
            : null,
          reactionKeys.length
            ? h(
                'div',
                { className: 'pmk-card' },
                h('div', { className: 'pmk-title' }, WORDS.reactionsTitle),
                h(
                  'div',
                  { className: 'pmk-kv' },
                  reactionKeys.map((event) => kvRow(event, JSON.stringify(reactions[event]))),
                ),
              )
            : null,
          h(
            'div',
            { className: 'pmk-card' },
            h('div', { className: 'pmk-title' }, WORDS.sourceTitle),
            h(
              'div',
              { className: 'pmk-kv' },
              kvRow('来源', entry.sourceRef || item.sourceRef || '—'),
              kvRow('内容指纹', entry.sha256 || '—'),
              kvRow('体积', entry.bytes ? fmtBytes(entry.bytes) : '—'),
              kvRow('安装目录', entry.dir || '—'),
              kvRow('装进来的时间', entry.installedAt || '—'),
              kvRow('出来玩的时间', entry.activatedAt || '—'),
              kvRow('作者 / 许可', (manifest.author || '—') + ' · ' + (manifest.license || '未声明')),
              manifest.homepage ? kvRow('主页', manifest.homepage) : null,
            ),
          ),
        ),
      )
    }

    function SettingsSection() {
      const [catalog, setCatalog] = useState({ installed: [], sources: [], jobs: [], storage: null, runtime: null })
      const [source, setSource] = useState('')
      const [busy, setBusy] = useState(false)
      const [over, setOver] = useState(false)
      const [error, setError] = useState(null)
      const [lastJob, setLastJob] = useState(null)
      // Server round-trips take a few hundred ms; without a local counter two
      // quick clicks both read the same `catalog` value and collapse into one.
      const [scaleDraft, setScaleDraft] = useState({})
      const [detailId, setDetailId] = useState(null)
      const fileRef = useRef(null)

      const refresh = useCallback(() => {
        return Promise.all([request('GET', API + 'catalog'), request('GET', API + 'jobs')])
          .then(([value, jobsValue]) => {
            setCatalog({
              installed: value.installed || [],
              sources: value.sources || [],
              jobs: jobsValue.jobs || [],
              ui: value.ui || null,
              storage: value.storage || null,
              runtime: value.runtime || null,
              desktop: value.desktop || null,
            })
          })
          .catch((err) => setError(friendlyError(err)))
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      useEffect(() => {
        let es = null
        try {
          es = new EventSource(urlFor(API + 'stream'))
        } catch (err) {
          return undefined
        }
        const onProgress = (event) => {
          const job = JSON.parse(event.data)
          setLastJob(job)
          setCatalog((prev) => {
            const jobs = (prev.jobs || []).filter((item) => item.jobId !== job.jobId)
            return { ...prev, jobs: [job, ...jobs].slice(0, 12) }
          })
        }
        const onDone = () => {
          setBusy(false)
          refresh()
        }
        es.addEventListener('job.progress', onProgress)
        es.addEventListener('job.done', onDone)
        es.addEventListener('job.failed', onDone)
        es.addEventListener('installed.changed', () => refresh())
        es.addEventListener('sources.changed', () => refresh())
        return () => {
          try {
            es.close()
          } catch (err) {
            /* ignore */
          }
        }
      }, [refresh])

      const installSource = useCallback(() => {
        const value = source.trim()
        if (!value) return
        setBusy(true)
        setError(null)
        request('POST', API + 'install', { source: value })
          .then((result) => {
            setLastJob(result.job)
            setCatalog((prev) => ({ ...prev, jobs: [result.job, ...(prev.jobs || [])].slice(0, 12) }))
          })
          .catch((err) => {
            setBusy(false)
            setError(friendlyError(err))
          })
      }, [source])

      const importFiles = useCallback(
        (files) => {
          const list = Array.from(files || [])
          if (!list.length) return
          setBusy(true)
          setError(null)
          const next = (index) => {
            if (index >= list.length) return Promise.resolve()
            const file = list[index]
            return file
              .arrayBuffer()
              .then((buffer) => upload(API + 'import', file.name || 'upload.dsppet', buffer))
              .then((result) => {
                setLastJob(result.job)
                setCatalog((prev) => ({ ...prev, jobs: [result.job, ...(prev.jobs || [])].slice(0, 12) }))
              })
              .then(() => next(index + 1))
          }
          next(0)
            .catch((err) => {
              setBusy(false)
              setError(friendlyError(err))
            })
            .then(() => setBusy(false))
        },
        [],
      )

      const act = useCallback(
        (petId, action, body) => {
          setError(null)
          request('POST', API + 'installed/' + encodeURIComponent(petId) + '/' + action, body || {})
            .then(() => refresh())
            .catch((err) => setError(friendlyError(err)))
        },
        [refresh],
      )

      const resizePet = useCallback(
        (petId, base, delta) => {
          const next = Math.max(1, Math.min(8, (Number(base) || 1) + delta))
          if (next === base) return
          setScaleDraft((prev) => ({ ...prev, [petId]: next }))
          request('POST', API + 'installed/' + encodeURIComponent(petId) + '/state', { scale: next })
            .then(() => refresh())
            .catch((err) => {
              setScaleDraft((prev) => {
                const copy = { ...prev }
                delete copy[petId]
                return copy
              })
              setError(friendlyError(err))
            })
        },
        [refresh],
      )

      const onDrop = useCallback(
        (event) => {
          event.preventDefault()
          setOver(false)
          const files = event.dataTransfer && event.dataTransfer.files
          if (files && files.length) importFiles(files)
        },
        [importFiles],
      )

      const installed = catalog.installed || []
      const jobs = (catalog.jobs || []).filter((job) => job.phase !== 'done').slice(0, 5)
      // One pet gets its own page: contract, animation table, rename, source.
      const detailItem = detailId ? installed.find((item) => item.petId === detailId) || null : null
      const runtime = catalog.runtime || {}
      const storage = catalog.storage || {}

      return h(
        'div',
        { className: 'pmk-root' },
        h(
          'div',
          { className: 'pmk-head' },
          h('div', { className: 'pmk-head-title' }, WORDS.panelTitle),
          h('div', { className: 'pmk-head-sub' }, WORDS.panelSub),
        ),
        error ? h('div', { className: 'pmk-err' }, error) : null,
        detailItem
          ? h(PetDetail, {
              item: detailItem,
              catalog,
              scaleDraft,
              onBack: () => setDetailId(null),
              onRefresh: refresh,
            })
          : null,
        detailItem
          ? null
          : h(
          'div',
          { className: 'pmk-card' },
          h('div', { className: 'pmk-title' }, '带一只回家'),
          h(
            'div',
            { className: 'pmk-row' },
            h('input', {
              className: 'pmk-input',
              placeholder: 'owner/repo 或 GitHub release 链接，也支持 local:<路径>',
              value: source,
              spellCheck: false,
              onChange: (event) => setSource(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') installSource()
              },
            }),
            h('button', { type: 'button', className: 'pmk-btn', 'data-tone': 'primary', disabled: busy, onClick: installSource }, WORDS.installAction),
          ),
          h(
            'div',
            {
              className: 'pmk-drop',
              'data-over': over ? 'true' : 'false',
              onDragOver: (event) => {
                event.preventDefault()
                setOver(true)
              },
              onDragLeave: () => setOver(false),
              onDrop,
              onClick: () => fileRef.current && fileRef.current.click(),
            },
            '把 .dsppet 或 .zip 素材包拖到这里（也可以点一下选文件）',
          ),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: '.dsppet,.zip,application/zip',
            multiple: true,
            style: { display: 'none' },
            onChange: (event) => importFiles(event.target.files),
          }),
          h(
            'div',
            { className: 'pmk-note' },
            '市场只校验格式与可运行性：素材长什么样、有哪些动作，由素材包自己决定。运行时 ' + (runtime.mode || '未知') + ' · 存储 ' + (storage.mode || '未知') + (storage.dataRoot ? ' · ' + storage.dataRoot : ''),
          ),
        ),
        detailItem
          ? null
          : h(
          'div',
          { className: 'pmk-card' },
          h('div', { className: 'pmk-title' }, WORDS.installedTitle + ' ' + installed.length),
          installed.length
            ? h(
                'div',
                { className: 'pmk-packs' },
                installed.map((item) => {
                  const entry = (item.versions || []).find((version) => version.version === item.activeVersion) || (item.versions || [])[0] || {}
                  const manifest = entry.manifest || {}
                  const thumbs = (entry.manifest && entry.manifest.thumbnail) || null
                  const savedPos = (catalog.ui && catalog.ui.positions && catalog.ui.positions[item.petId]) || null
                  const serverScale = (savedPos && Number(savedPos.scale)) || scaleFor(entry.renderer && entry.renderer.frame)
                  const currentScale = scaleDraft[item.petId] || serverScale
                  const resize = (delta) => resizePet(item.petId, currentScale, delta)
                  const displayName = (catalog.ui && catalog.ui.names && catalog.ui.names[item.petId]) || manifest.name || item.petId
                  return h(
                    'div',
                    { key: item.petId, className: 'pmk-pack', 'data-active': item.active ? 'true' : 'false' },
                    thumbs
                      ? h('img', { className: 'pmk-thumb', alt: '', src: packAsset(item.petId, entry.version, thumbs) })
                      : h('div', { className: 'pmk-thumb' }),
                    h(
                      'div',
                      { className: 'pmk-pack-body' },
                      h(NameCell, { petId: item.petId, value: displayName, onSaved: refresh }),
                      h(
                        'div',
                        { className: 'pmk-meta' },
                        item.petId + ' · v' + (entry.version || '?') + (entry.bytes ? ' · ' + fmtBytes(entry.bytes) : '') + ' · ' + currentScale + 'x',
                      ),
                    ),
                    h(
                      'div',
                      { className: 'pmk-row' },
                      h('button', { type: 'button', className: 'pmk-btn', onClick: () => setDetailId(item.petId) }, WORDS.detail),
                      item.active
                        ? h('button', { type: 'button', className: 'pmk-btn', onClick: () => act(item.petId, 'disable') }, WORDS.asleep)
                        : h('button', { type: 'button', className: 'pmk-btn', 'data-tone': 'primary', onClick: () => act(item.petId, 'activate', { version: entry.version }) }, WORDS.awake),
                      h(
                        'button',
                        { type: 'button', className: 'pmk-btn pmk-btn-icon', title: '缩小', 'aria-label': '缩小', onClick: () => resize(-1), disabled: currentScale <= 1 },
                        '−',
                      ),
                      h('span', { className: 'pmk-scale' }, currentScale + 'x'),
                      h(
                        'button',
                        { type: 'button', className: 'pmk-btn pmk-btn-icon', title: '放大', 'aria-label': '放大', onClick: () => resize(1), disabled: currentScale >= 8 },
                        '+',
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'pmk-btn', 'data-tone': 'danger', onClick: () => act(item.petId, 'uninstall', { version: entry.version }) },
                        WORDS.remove,
                      ),
                    ),
                  )
                }),
              )
            : h('div', { className: 'pmk-note' }, WORDS.empty),
        ),
        detailItem ? null : jobs.length ? h('div', { className: 'pmk-card' }, h('div', { className: 'pmk-title' }, '进行中'), h('div', { className: 'pmk-jobs' }, jobs.map((job) => h(JobRow, { key: job.jobId, job })))) : null,
        detailItem ? null : catalog.sources && catalog.sources.length
          ? h(
              'div',
              { className: 'pmk-card' },
              h('div', { className: 'pmk-title' }, '订阅的源'),
              h(
                'div',
                { className: 'pmk-packs' },
                catalog.sources.map((item) =>
                  h(
                    'div',
                    { key: item.id, className: 'pmk-pack' },
                    h('div', { className: 'pmk-pack-body' }, h('div', { className: 'pmk-pack-name' }, item.label || item.sourceRef), h('div', { className: 'pmk-meta' }, item.sourceRef)),
                    h(
                      'button',
                      { type: 'button', className: 'pmk-btn', onClick: () => setSource(item.sourceRef) },
                      '填入',
                    ),
                  ),
                ),
              ),
            )
          : null,
        lastJob && lastJob.phase === 'failed' ? h('div', { className: 'pmk-note' }, '最后一次失败：' + lastJob.phase + ' · ' + (lastJob.message || '')) : null,
      )
    }

    // --------------------------------------------------------------- plugin

    function mountSlot(slots, seat) {
      const node = { name: seat.name, id: seat.id, order: seat.order }
      if (seat.key) node.key = seat.key
      if (seat.label) node.label = seat.label
      if (typeof slots.inject === 'function') {
        return slots.inject(seat.name, () => slots.register(node, seat.Component))
      }
      return slots.register(node, seat.Component)
    }

    // A host without one of these slots must still get the other seats.
    function safeMount(slots, seat) {
      try {
        return mountSlot(slots, seat)
      } catch (error) {
        console.warn('[petmarket] seat ' + seat.name + ' not mounted: ' + (error && error.message ? error.message : error))
        return undefined
      }
    }

    function SidebarIcon(props) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: props && props.size ? props.size : 16, height: props && props.size ? props.size : 16, 'aria-hidden': 'true' },
        h('path', { d: 'M5 11c0-3 2.6-5 6-5s6 2 6 5-2.6 5-6 5c-1 0-2-.2-2.8-.5L5 17l.8-3.1A5.6 5.6 0 0 1 5 11Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }),
        h('circle', { cx: 9, cy: 10.5, r: 0.9, fill: 'currentColor' }),
        h('circle', { cx: 13, cy: 10.5, r: 0.9, fill: 'currentColor' }),
      )
    }

    function MarketPanel(props) {
      return h(SettingsSection, props || {})
    }

    return {
      // `slots` is the only client service the market must have; the host's
      // sandbox rejects property reads for services missing from this list.
      inject: ['slots'],
      apply(ctx) {
        try {
          services.slots = svc(ctx, 'slots')
          services.styles = svc(ctx, 'styles')
          services.timer = svc(ctx, 'timer')
          services.locale = svc(ctx, 'locale')

          if (!services.slots) {
            console.warn('[petmarket] slots service unavailable; market UI not mounted')
            return
          }

          ctx.effect(() => installStyles(services.styles))

          ctx.effect(() => safeMount(services.slots, {
              name: 'settings.section',
              id: SETTINGS_ID,
              order: 61,
              label: () => '宠物乐园',
              Component: SettingsSection,
            }),
          )

          // The sidebar entry is what makes the market discoverable from the main
          // page; the settings section alone hides it behind one more click.
          ctx.effect(() => safeMount(services.slots, {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 1,
              label: () => '宠物乐园',
              Component: SidebarIcon,
            }),
          )
          ctx.effect(() => safeMount(services.slots, {
              name: 'main',
              key: PANEL_ID,
              Component: MarketPanel,
            }),
          )

          ctx.effect(() => safeMount(services.slots, { name: 'shell.overlay', id: OVERLAY_ID, order: 901, Component: PetStage }))
        } catch (error) {
          console.error('[petmarket] market UI failed to mount:', error)
        }
      },
    }
  },
})


