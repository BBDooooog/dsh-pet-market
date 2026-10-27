// Desktop stage renderer. Plain DOM + one rAF loop per pet: no framework, no
// build step, and the only IPC traffic is "position saved" on drag release.
;(function () {
  const stage = document.getElementById('stage')
  const bridge = window.petStage
  const pets = new Map()
  let bounds = { width: 0, height: 0 }
  let lastState = null

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

  function animFor(pet, pose) {
    const name = (pet.states && pet.states[pose]) || pose
    const anim = pet.animations ? pet.animations[name] : null
    if (anim) return { name, anim }
    const idleName = pet.states && pet.states.idle
    if (idleName && pet.animations[idleName]) return { name: idleName, anim: pet.animations[idleName] }
    const first = pet.animations ? Object.keys(pet.animations)[0] : null
    return first ? { name: first, anim: pet.animations[first] } : { name: null, anim: null }
  }

  function frameOffset(pet, anim, index) {
    const frame = pet.frame || { w: 32, h: 32 }
    const sheet = pet.sheet || { margin: 0, spacing: 0 }
    const margin = Number(sheet.margin) || 0
    const spacing = Number(sheet.spacing) || 0
    const row = Number(anim.row) || 0
    const col = (Number(anim.from) || 0) + index
    return { x: margin + col * (frame.w + spacing), y: margin + row * (frame.h + spacing) }
  }

  function createElement(pet) {
    const el = document.createElement('div')
    el.className = 'pet'
    el.title = pet.name || pet.petId
    el.style.backgroundImage = 'url("' + pet.image + '")'
    const frame = pet.frame || { w: 32, h: 32 }
    const sheet = pet.sheet || { width: frame.w, height: frame.h }
    const scale = Number(pet.pos && pet.pos.scale) || 1
    el.style.width = frame.w * scale + 'px'
    el.style.height = frame.h * scale + 'px'
    el.style.backgroundSize = sheet.width * scale + 'px ' + sheet.height * scale + 'px'
    el.style.transform = 'translate3d(' + Math.round(pet.pos.x) + 'px,' + Math.round(pet.pos.y) + 'px,0)' + (Number(pet.pos.facing) === -1 ? ' scaleX(-1)' : '')
    el.dataset.petId = pet.petId
    stage.appendChild(el)

    const record = {
      pet,
      el,
      pose: 'idle',
      index: 0,
      started: performance.now(),
      holdUntil: 0,
      drag: null,
      wander: null,
      scale,
      frame,
    }
    attachPointer(record)
    return record
  }

  function attachPointer(record) {
    const { el } = record
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      el.setPointerCapture(event.pointerId)
      el.dataset.dragging = 'true'
      // While a drag is live the host must keep the window interactive even when
      // the cursor leaves the sprite rectangle; otherwise the drag is cut off.
      if (bridge && bridge.dragging) bridge.dragging(true)
      record.drag = { startX: event.screenX, startY: event.screenY, originX: record.pet.pos.x, originY: record.pet.pos.y, moved: false }
    })
    el.addEventListener('pointermove', (event) => {
      if (!record.drag) return
      const dx = event.screenX - record.drag.startX
      const dy = event.screenY - record.drag.startY
      if (Math.abs(dx) + Math.abs(dy) > 3) record.drag.moved = true
      record.wander = null
      const x = clamp(record.drag.originX + dx, -record.frame.w, bounds.width - record.frame.w * record.scale)
      const y = clamp(record.drag.originY + dy, 0, bounds.height - record.frame.h * record.scale)
      record.pet.pos.x = x
      record.pet.pos.y = y
      paint(record)
    })
    const release = (event) => {
      if (!record.drag) return
      const moved = record.drag.moved
      record.drag = null
      el.dataset.dragging = 'false'
      if (bridge && bridge.dragging) bridge.dragging(false)
      try {
        el.releasePointerCapture(event.pointerId)
      } catch (err) {
        /* pointer already released */
      }
      if (moved) {
        bridge && bridge.persist(record.pet.petId, { x: Math.round(record.pet.pos.x), y: Math.round(record.pet.pos.y), scale: record.scale, facing: record.pet.pos.facing || 1 })
      } else {
        record.holdUntil = performance.now() + 1500
        setPose(record, 'happy', performance.now())
      }
    }
    el.addEventListener('pointerup', release)
    el.addEventListener('pointercancel', release)
  }

  function paint(record) {
    const facing = Number(record.pet.pos.facing) === -1 ? ' scaleX(-1)' : ''
    record.el.style.transform = 'translate3d(' + Math.round(record.pet.pos.x) + 'px,' + Math.round(record.pet.pos.y) + 'px,0)' + facing
  }

  function paintFrame(record) {
    const { anim } = animFor(record.pet, record.pose)
    if (!anim) return
    const offset = frameOffset(record.pet, anim, record.index)
    record.el.style.backgroundPosition = -offset.x * record.scale + 'px ' + -offset.y * record.scale + 'px'
  }

  function setPose(record, pose, now) {
    record.pose = pose
    record.started = now
    record.index = 0
    paintFrame(record)
  }

  function tick(now) {
    for (const record of pets.values()) {
      const { anim } = animFor(record.pet, record.pose)
      if (!anim) continue
      const total = Number(anim.frames) || 1
      const fps = Math.max(1, Number(anim.fps) || 8)
      const raw = Math.floor(((now - record.started) * fps) / 1000)
      let index
      if (anim.direction === 'pingpong' && total > 1) {
        const span = total * 2 - 2
        const cycle = raw % span
        index = cycle < total ? cycle : span - cycle
      } else if (anim.loop === false) {
        index = Math.min(raw, total - 1)
        if (raw >= total) {
          const holdEnds = now < (record.holdUntil || 0)
          if (!holdEnds && record.pose !== 'idle') setPose(record, 'idle', now)
          stepWander(record, now)
          continue
        }
      } else {
        index = raw % total
      }
      if (index !== record.index) {
        record.index = index
        paintFrame(record)
      }
      stepWander(record, now)
    }
    requestAnimationFrame(tick)
  }

  function stepWander(record, now) {
    if (record.drag) return
    if (!record.wander) {
      if (record.pos0 === undefined) record.pos0 = {}
      record.nextWander = record.nextWander || now + 6000 + Math.random() * 8000
      if (now < record.nextWander) return
      if (!record.pet.animations || !record.pet.animations.walk) {
        record.nextWander = now + 12000
        return
      }
      const dir = Math.random() < 0.5 ? -1 : 1
      const travel = (30 + Math.random() * 70) * record.scale
      const from = record.pet.pos.x
      const to = clamp(from + travel * dir, 0, Math.max(0, bounds.width - record.frame.w * record.scale))
      record.wander = { from, to, start: now, duration: 1200 + Math.abs(to - from) * 12 }
      setPose(record, 'walk', now)
    } else {
      const { from, to, start, duration } = record.wander
      const t = Math.min(1, (now - start) / duration)
      record.pet.pos.x = from + (to - from) * t
      paint(record)
      if (t >= 1) {
        record.wander = null
        setPose(record, 'idle', now)
        record.nextWander = now + 7000 + Math.random() * 9000
        bridge && bridge.persist(record.pet.petId, { x: Math.round(record.pet.pos.x), y: Math.round(record.pet.pos.y), scale: record.scale, facing: record.pet.pos.facing || 1 })
      }
    }
  }

  function applyState(payload) {
    if (!payload) return
    lastState = payload
    bounds = payload.bounds || bounds
    const wanted = new Map((payload.pets || []).map((pet) => [pet.petId, pet]))
    for (const [petId, record] of Array.from(pets.entries())) {
      if (!wanted.has(petId)) {
        record.el.remove()
        pets.delete(petId)
      }
    }
    for (const pet of wanted.values()) {
      const existing = pets.get(pet.petId)
      if (!existing) {
        const record = createElement(pet)
        pets.set(pet.petId, record)
        paintFrame(record)
        continue
      }
      existing.pet = pet
      existing.scale = Number(pet.pos && pet.pos.scale) || 1
      existing.el.style.backgroundImage = 'url("' + pet.image + '")'
      existing.el.style.width = pet.frame.w * existing.scale + 'px'
      existing.el.style.height = pet.frame.h * existing.scale + 'px'
      existing.el.style.backgroundSize = pet.sheet.width * existing.scale + 'px ' + pet.sheet.height * existing.scale + 'px'
      paint(existing)
      paintFrame(existing)
    }
    document.body.style.background = 'transparent'
  }

  if (bridge) {
    bridge.onState(applyState)
    bridge.ready()
  }

  window.addEventListener('resize', () => {
    if (!lastState) return
    bounds = { width: window.innerWidth, height: window.innerHeight }
  })

  requestAnimationFrame(tick)
})()



