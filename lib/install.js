// Install pipeline. One job at a time, every step observable, every failure
// rolled back to the state that existed before the job started.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MarketError, isObject, normalizeRelPath, nowIso } from './util.js'
import { extractAll, openZip, stripCommonRoot } from './zip.js'
import { validatePack, compareVersions, BUDGET } from './pack.js'
import { sha256 } from './hash.js'
import { downloadToFile } from './download.js'
import { planGithubDownload } from './github.js'
import { parseSource } from './sources.js'

const WEIGHTS = { resolving: 5, downloading: 60, verifying: 10, validating: 15, staging: 5, committing: 3, registering: 2 }
const ORDER = ['queued', 'resolving', 'downloading', 'verifying', 'validating', 'staging', 'committing', 'registering', 'done']

function progressFor(phase, inner) {
  let base = 0
  for (const name of ORDER) {
    if (name === phase) break
    base += WEIGHTS[name] || 0
  }
  return Math.min(100, Math.round(base + (WEIGHTS[phase] || 0) * Math.max(0, Math.min(1, inner))))
}

function readTreeDir(root, rel = '', collected = {}) {
  const dir = rel ? join(root, rel) : root
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store' || name === '__MACOSX' || name === 'Thumbs.db') continue
    const childRel = rel ? rel + '/' + name : name
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) readTreeDir(root, childRel, collected)
    else if (stat.isFile()) {
      if (stat.size > BUDGET.maxFileBytes) throw new MarketError('asset-too-large', 'file too large: ' + childRel)
      collected[childRel] = readFileSync(full)
    }
  }
  return collected
}

export function createInstaller({ store, runtime, events, config = {}, logger }) {
  const jobs = new Map()
  const queue = []
  let running = null
  let seq = 0

  function emit(type, data) {
    if (events && typeof events.broadcast === 'function') {
      try {
        events.broadcast(type, data)
      } catch {
        // listener errors never break installs
      }
    }
  }

  function snapshotJob(job) {
    return {
      jobId: job.jobId,
      kind: job.kind,
      sourceRef: job.sourceRef,
      phase: job.phase,
      progress: job.progress,
      petId: job.petId || null,
      version: job.version || null,
      message: job.message || null,
      error: job.error || null,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      canceled: job.canceled === true,
      result: job.result || null,
      steps: job.steps.slice(),
    }
  }

  function listJobs() {
    return Array.from(jobs.values()).map(snapshotJob).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  }

  function getJob(jobId) {
    const job = jobs.get(jobId)
    return job ? snapshotJob(job) : null
  }

  function cancel(jobId) {
    const job = jobs.get(jobId)
    if (!job) throw new MarketError('job-not-found', 'no such job: ' + jobId)
    if (job.phase === 'done') return snapshotJob(job)
    job.canceled = true
    job.controller.abort()
    setPhase(job, 'failed', 'job-canceled', 'canceled by user')
    return snapshotJob(job)
  }

  function setPhase(job, phase, code, message) {
    job.phase = phase
    job.progress = phase === 'done' ? 100 : progressFor(phase, 0)
    if (message) job.message = message
    if (code) job.error = { code, message: message || code }
    job.updatedAt = nowIso()
    job.steps.push({ phase, at: job.updatedAt, code: code || null, message: message || null })
    emit('job.progress', snapshotJob(job))
    if (logger) logger.info('job ' + job.jobId + ' -> ' + phase + (message ? ': ' + message : ''))
  }

  function advance(job, phase, inner, message) {
    if (job.canceled) throw new MarketError('job-canceled', 'job canceled')
    job.phase = phase
    job.progress = progressFor(phase, inner)
    if (message !== undefined) job.message = message
    emit('job.progress', snapshotJob(job))
  }

  function enqueue(spec) {
    const duplicate = Array.from(jobs.values()).find(
      (job) => job.phase !== 'done' && job.phase !== 'failed' && job.sourceRef === spec.sourceRef && job.kind === spec.kind,
    )
    if (duplicate) return snapshotJob(duplicate)
    seq += 1
    const job = {
      jobId: 'job-' + Date.now().toString(36) + '-' + seq,
      kind: spec.kind,
      sourceRef: spec.sourceRef,
      input: spec.input || null,
      payload: spec.payload || null,
      phase: 'queued',
      progress: 0,
      steps: [{ phase: 'queued', at: nowIso() }],
      startedAt: nowIso(),
      controller: new AbortController(),
      canceled: false,
      message: null,
      error: null,
      result: null,
    }
    jobs.set(job.jobId, job)
    queue.push(job)
    emit('job.progress', snapshotJob(job))
    pump()
    return snapshotJob(job)
  }

  async function pump() {
    if (running) return
    const job = queue.shift()
    if (!job) return
    running = job
    try {
      const result = await run(job)
      job.result = result
      setPhase(job, 'done', null, 'installed ' + result.petId + '@' + result.version)
      job.finishedAt = nowIso()
      emit('job.done', snapshotJob(job))
      emit('installed.changed', { petId: result.petId, version: result.version })
    } catch (err) {
      const code = err && err.code ? err.code : 'job-failed'
      const message = err && err.message ? err.message : String(err)
      setPhase(job, 'failed', code, message)
      job.finishedAt = nowIso()
      if (job.stageDir) {
        try {
          rmSync(job.stageDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
      emit('job.failed', snapshotJob(job))
      if (logger) logger.warn('job ' + job.jobId + ' failed: ' + code + ' ' + message)
    } finally {
      running = null
      setTimeout(pump, 0)
    }
  }

  async function run(job) {
    advance(job, 'resolving', 0, 'resolving source')
    let files = null
    let meta = { sourceRef: job.sourceRef, sourceUrl: null, tag: null, assetName: null, digest: null }

    if (job.kind === 'github') {
      const source = parseSource(job.sourceRef)
      const plan = await planGithubDownload(source, {
        cacheDir: store.paths.cache,
        allowPrerelease: config.allowPrerelease === true,
      })
      meta.tag = plan.tag
      meta.assetName = plan.assetName
      meta.sourceUrl = plan.url
      meta.digest = plan.digest || null
      advance(job, 'downloading', 0, 'downloading ' + plan.assetName)
      const dest = join(store.tmpDir(job.jobId), plan.assetName.replace(/[^A-Za-z0-9._-]/g, '_'))
      mkdirSync(store.tmpDir(job.jobId), { recursive: true })
      const download = await downloadToFile(plan.url, dest, {
        maxBytes: BUDGET.maxPackBytes,
        onProgress: (event) => {
          const inner = event.total ? event.received / event.total : 0.4
          advance(job, 'downloading', inner, 'downloading ' + Math.round(event.received / 1024) + ' KiB')
        },
      })
      advance(job, 'verifying', 0, 'verifying digest')
      if (plan.digest && download.sha256 !== plan.digest) {
        throw new MarketError('digest-mismatch', 'sha256 mismatch: expected ' + plan.digest + ', got ' + download.sha256)
      }
      files = readPackageFile(dest)
      meta.sha256 = download.sha256
    } else if (job.kind === 'upload') {
      const buffer = job.payload
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new MarketError('zip-invalid', 'uploaded file is empty')
      if (buffer.length > BUDGET.maxPackBytes) throw new MarketError('asset-too-large', 'package exceeds ' + BUDGET.maxPackBytes + ' bytes')
      advance(job, 'verifying', 0.4, 'hashing upload')
      meta.sha256 = sha256(buffer)
      meta.assetName = job.input || 'upload.dsppet'
      files = readPackageBuffer(buffer)
    } else if (job.kind === 'local-file') {
      const path = String(job.input || '')
      if (!existsSync(path)) throw new MarketError('source-invalid', 'no such file: ' + path)
      const stat = statSync(path)
      if (!stat.isFile()) throw new MarketError('source-invalid', 'not a file: ' + path)
      if (stat.size > BUDGET.maxPackBytes) throw new MarketError('asset-too-large', 'package exceeds ' + BUDGET.maxPackBytes + ' bytes')
      advance(job, 'verifying', 0.4, 'hashing ' + path)
      const buffer = readFileSync(path)
      meta.sha256 = sha256(buffer)
      meta.sourceUrl = 'file://' + path
      meta.assetName = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1)
      files = readPackageBuffer(buffer)
    } else if (job.kind === 'local-dir') {
      const path = resolve(String(job.input || ''))
      if (!existsSync(path)) throw new MarketError('source-invalid', 'no such directory: ' + path)
      if (!statSync(path).isDirectory()) throw new MarketError('source-invalid', 'not a directory: ' + path)
      advance(job, 'staging', 0.2, 'reading folder')
      files = stripCommonRoot(readTreeDir(path))
      if (files['pet.json'] === undefined) {
        const nested = Object.keys(files).filter((name) => name.endsWith('/pet.json'))
        if (nested.length === 1) {
          const prefix = nested[0].slice(0, nested[0].length - 'pet.json'.length)
          const trimmed = Object.create(null)
          for (const name of Object.keys(files)) trimmed[name.slice(prefix.length)] = files[name]
          files = trimmed
        }
      }
      meta.sha256 = sha256(Buffer.from(Object.keys(files).sort().map((name) => name + ':' + sha256(files[name])).join('\n')))
      meta.sourceUrl = 'file://' + path
      meta.assetName = null
    } else {
      throw new MarketError('invalid-params', 'unsupported job kind: ' + job.kind)
    }

    advance(job, 'validating', 0, 'validating package')
    const manifest = validatePack({ files, expectedId: job.expectedId || null })
    job.petId = manifest.petId
    job.version = manifest.version
    advance(job, 'validating', 1, manifest.petId + '@' + manifest.version)

    const existing = store.get(manifest.petId)
    const currentVersion = existing && existing.activeVersion ? existing.activeVersion : null
    if (currentVersion && compareVersions(manifest.version, currentVersion) < 0 && config.allowDowngrade !== true) {
      throw new MarketError('downgrade-blocked', 'installed ' + currentVersion + ' is newer than ' + manifest.version)
    }

    advance(job, 'staging', 0.2, 'writing files')
    const stageDir = store.tmpDir(job.jobId) + '/stage'
    rmSync(stageDir, { recursive: true, force: true })
    mkdirSync(stageDir, { recursive: true })
    for (const name of Object.keys(files)) {
      const clean = normalizeRelPath(name)
      if (!clean) throw new MarketError('path-traversal', 'unsafe file name: ' + name)
      const target = join(stageDir, clean)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, files[name])
    }
    writeFileSync(
      join(stageDir, '.market-install.json'),
      JSON.stringify({ petId: manifest.petId, version: manifest.version, sourceRef: meta.sourceRef, sourceUrl: meta.sourceUrl, installedAt: nowIso() }, null, 2),
      'utf8',
    )
    job.stageDir = stageDir

    advance(job, 'committing', 0.4, 'committing')
    const targetDir = store.packDir(manifest.petId, manifest.version)
    mkdirSync(join(targetDir, '..'), { recursive: true })
    const backupDir = targetDir + '.old-' + job.jobId
    if (existsSync(targetDir)) {
      try {
        renameSync(targetDir, backupDir)
      } catch {
        cpSync(targetDir, backupDir, { recursive: true })
        rmSync(targetDir, { recursive: true, force: true })
      }
    }
    try {
      renameSync(stageDir, targetDir)
    } catch (err) {
      try {
        cpSync(stageDir, targetDir, { recursive: true })
        rmSync(stageDir, { recursive: true, force: true })
      } catch (inner) {
        throw new MarketError('disk-error', 'cannot commit pack: ' + (inner && inner.message ? inner.message : inner))
      }
    }
    try {
      rmSync(backupDir, { recursive: true, force: true })
    } catch {
      // ignore
    }

    advance(job, 'registering', 0.2, 'registering with host')
    const record = {
      state: 'installed',
      installedAt: nowIso(),
      sha256: meta.sha256 || null,
      sourceRef: meta.sourceRef,
      sourceUrl: meta.sourceUrl,
      tag: meta.tag,
      assetName: meta.assetName,
      dir: targetDir,
      profile: manifest.profile,
      bytes: manifest.bytes,
      renderer: { type: manifest.renderer.type, mode: manifest.renderer.mode, frame: manifest.renderer.frame },
      manifest: {
        petId: manifest.petId,
        version: manifest.version,
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        license: manifest.license,
        homepage: manifest.homepage,
        profile: manifest.profile,
        renderer: manifest.renderer,
        bubble: manifest.bubble,
        menus: manifest.menus,
        reactions: manifest.reactions,
        actions: manifest.actions,
        market: manifest.market,
        thumbnail: manifest.thumbnail,
        warnings: manifest.warnings,
      },
    }
    store.recordVersion(manifest.petId, manifest.version, record)
    // Re-installing byte-identical content that the host already knows about is a
    // no-op for the host: it would otherwise answer pack-id-conflict.
    const prior = existing && existing.versions ? existing.versions[manifest.version] : null
    const knownToHost = runtime.known().some((entry) => entry.petId === manifest.petId && entry.version === manifest.version)
    const sameContent = !!(prior && meta.sha256 && prior.sha256 === meta.sha256 && prior.state !== 'broken')
    const reuse = knownToHost && sameContent
    const runtimeResult = reuse
      ? { ok: true, via: 'cached' }
      : await runtime.register({
          petId: manifest.petId,
          version: manifest.version,
          profile: manifest.profile,
          dir: targetDir,
          source: 'market:' + meta.sourceRef + '@' + manifest.version,
          manifest: record.manifest,
          files: Object.keys(files).sort(),
        })
    if (runtimeResult && runtimeResult.ok === false) {
      store.recordVersion(manifest.petId, manifest.version, { ...record, state: 'broken', runtimeError: runtimeResult.error || null })
      throw new MarketError('runtime-rejected', String(runtimeResult.error || 'host rejected the pack'))
    }
    const meta2 = store.get(manifest.petId)
    meta2.activeVersion = manifest.version
    meta2.active = true
    if (!meta2.sourceRef) meta2.sourceRef = meta.sourceRef
    store.saveLedger()
    const activated = await runtime.activate(manifest.petId, manifest.version)
    store.recordVersion(manifest.petId, manifest.version, {
      ...record,
      state: activated === false ? 'pending-restart' : 'installed',
      activatedAt: activated === false ? null : nowIso(),
    })
    store.prune(manifest.petId, Number(config.keepVersions || 1))
    store.log('info', 'installed pack', { petId: manifest.petId, version: manifest.version })
    return {
      petId: manifest.petId,
      version: manifest.version,
      name: manifest.name,
      profile: manifest.profile,
      runtime: runtime.mode,
      renderer: manifest.renderer,
      warnings: manifest.warnings,
      dir: targetDir,
    }
  }

  function readPackageBuffer(buffer) {
    const zip = openZip(buffer)
    return stripCommonRoot(extractAll(zip))
  }

  function readPackageFile(path) {
    const stat = statSync(path)
    if (stat.size > BUDGET.maxPackBytes) throw new MarketError('asset-too-large', 'package exceeds ' + BUDGET.maxPackBytes + ' bytes')
    return readPackageBuffer(readFileSync(path))
  }

  async function activate(petId, version) {
    const record = store.get(petId)
    if (!record || !isObject(record.versions)) throw new MarketError('pack-not-found', 'pack not installed: ' + petId)
    const target = version || record.activeVersion
    if (!target || !record.versions[target]) throw new MarketError('pack-not-found', 'version not installed: ' + petId + '@' + String(target))
    const entry = record.versions[target]
    const ok = await runtime.activate(petId, target)
    record.activeVersion = target
    record.active = ok !== false
    store.ledger.packs[petId] = record
    store.saveLedger()
    store.recordVersion(petId, target, { ...entry, state: ok === false ? 'pending-restart' : 'installed', activatedAt: ok === false ? entry.activatedAt || null : nowIso() })
    emit('installed.changed', { petId, version: target })
    return { petId, version: target, active: record.active }
  }

  async function disable(petId) {
    const record = store.get(petId)
    if (!record) throw new MarketError('pack-not-found', 'pack not installed: ' + petId)
    await runtime.deactivate(petId)
    record.active = false
    store.ledger.packs[petId] = record
    store.saveLedger()
    if (record.activeVersion && record.versions && record.versions[record.activeVersion]) {
      store.recordVersion(petId, record.activeVersion, { ...record.versions[record.activeVersion], state: 'disabled' })
    }
    emit('installed.changed', { petId, version: record.activeVersion })
    return { petId, active: false }
  }

  async function uninstall(petId, version) {
    const record = store.get(petId)
    if (!record || !isObject(record.versions)) throw new MarketError('pack-not-found', 'pack not installed: ' + petId)
    const target = version || record.activeVersion || Object.keys(record.versions)[0]
    const entry = record.versions[target]
    if (!entry) throw new MarketError('pack-not-found', 'version not installed: ' + petId + '@' + String(target))
    const released = await runtime.unregister(petId)
    store.removeVersion(petId, target)
    emit('installed.changed', { petId, version: target, removed: true })
    return { petId, version: target, released: released !== false, pendingRestart: released === false }
  }

  return { enqueue, listJobs, getJob, cancel, activate, disable, uninstall, snapshot: () => listJobs() }
}
