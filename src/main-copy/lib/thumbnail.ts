/**
 * Thumbnail helper.
 * Audio: embedded picture via ID3/MP4 tags (jsmediatags if available).
 * Video: first decodable frame and/or a duration-relative seek via a hidden
 * <video> + canvas. Returns a data URL or null (caller falls back to an icon).
 *
 * Results are memoized in a module-level cache AND persisted to IndexedDB
 * (keyed by fileName), so each file is probed once per device instead of once
 * per app launch. Views seed their thumbs state from the memory cache and
 * hydrate from IDB on mount.
 *
 * Lock-screen hygiene: a parked probe at a non-zero seek position registers a
 * competing iOS Now Playing timeline (the phantom ~4s seek bar). Mitigations:
 * - serialized probes (one media element at a time, deduped by fileName)
 * - a seekless frame-0 path that never writes `currentTime` while audio plays
 * - aborts in-flight probes on any user seek and when the page goes hidden
 * - a short cooldown after an abort so the probe loop does not reopen the
 *   window the moment the user stops scrubbing
 * - frame validation (mean luminance + contrast) so dark/flat frames fall
 *   through to later seeks instead of producing a black rectangle
 */

import { addLog } from './logger'
import { usePlayerStore } from '../stores/playerStore'
import { getAllThumbnails, saveThumbnail as persistThumbnail, deleteThumbnail } from './idb'

const thumbnailCache = new Map<string, string | null>()
const MAX_CACHED_THUMBNAILS = 500

const LOAD_TIMEOUT_MS = 8000
const SEEK_TIMEOUT_MS = 2500
const MAX_SEEK_ATTEMPTS = 5 //3 initially
const SEEK_MIN_SEC = 2  // adjust this for minimal seek used at least once, 3 intially. use this to make duration fraction more accurate.
const SEEK_MAX_SEC = 30
const SEEK_DURATION_FRACTION = 0.2 // adjust this one for video probing 0.1 initially
const SEEK_STEP_FRACTION = 0.8 // 0.08 intially, don't know what this does yet.
const SEEK_STEP_MAX_SEC = 15
const DARK_MEAN = 7 // 8 intially
const BRIGHT_MEAN = 245
const MIN_STDDEV = 5
// Dark-but-detailed frames (white text on black, letterboxed night scenes):
// high contrast over a dark background is real content — accept it even
// though the mean is below DARK_MEAN. Flat black stays rejected.
const DARK_DETAIL_STDDEV = 25
const SEEK_COOLDOWN_MS = 2000
const PROBE_PLAY_KEY = 'thumb-probe-during-playback'

let probeDuringPlayback = false
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(PROBE_PLAY_KEY) === '1') probeDuringPlayback = true
} catch { /* ignore */ }

export function getProbeDuringPlayback(): boolean {
  return probeDuringPlayback
}

export function setProbeDuringPlayback(on: boolean): void {
  probeDuringPlayback = on
  try { localStorage.setItem(PROBE_PLAY_KEY, on ? '1' : '0') } catch { /* ignore */ }
  addLog(`thumb: probe while playing ${on ? 'ON (seekless only)' : 'OFF'}`)
}

// ---------------------------------------------------------------------------
// Cache + IDB hydration
// ---------------------------------------------------------------------------

let hydration: Promise<void> | null = null

function ensureHydrated(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      try {
        const stored = await getAllThumbnails()
        let added = 0
        for (const [key, url] of Object.entries(stored)) {
          if (!thumbnailCache.has(key)) {
            // Empty string = persisted "no usable frame" marker, not a URL.
            thumbnailCache.set(key, url === '' ? null : url)
            added++
          }
        }
        if (added > 0) addLog(`thumb: hydrated ${added} persisted thumbnail${added === 1 ? '' : 's'}`)
      } catch (e) {
        addLog(`thumb: hydrate failed (${e})`)
      }
    })()
  }
  return hydration
}

export function getCachedThumbnails(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, url] of thumbnailCache) if (url) out[key] = url
  return out
}

export async function loadPersistedThumbnails(): Promise<Record<string, string>> {
  await ensureHydrated()
  return getCachedThumbnails()
}

export function removeCachedThumbnail(fileName: string): void {
  thumbnailCache.delete(fileName)
}

export function clearThumbnailCache(): void {
  thumbnailCache.clear()
}

// Undo persistent "no usable frame" markers (and any in-memory nulls) so those
// files get re-probed with the current seek constants. Use after retuning.
export async function clearThumbnailFailureMarks(): Promise<void> {
  await ensureHydrated()
  const marked: string[] = []
  for (const [key, value] of thumbnailCache) {
    if (value === null) marked.push(key)
    thumbnailCache.delete(key)
  }
  for (const key of marked) {
    try { await deleteThumbnail(key) } catch { /* already gone */ }
  }
  addLog(`thumb: cleared ${marked.length} failure marker${marked.length === 1 ? '' : 's'} — files will re-probe`)
}

function cacheInMemory(key: string, url: string | null): void {
  if (thumbnailCache.size >= MAX_CACHED_THUMBNAILS && !thumbnailCache.has(key)) {
    const oldest = thumbnailCache.keys().next().value
    if (oldest !== undefined) thumbnailCache.delete(oldest)
  }
  thumbnailCache.set(key, url)
}

// ---------------------------------------------------------------------------
// Probe gating / serialization
// ---------------------------------------------------------------------------

const seeklessAttempted = new Set<string>()
let suspended = false
let cooldownUntil = 0
let abortEpoch = 0
let probeSeq = 0
let resumeTimer: ReturnType<typeof setTimeout> | null = null
let activeAbort: { id: number; abort: (reason: string) => void } | null = null

function syncPlayEpoch(): boolean {
  return usePlayerStore.getState().isPlaying
}

export function canProbeNow(): boolean {
  if (suspended) return false
  if (Date.now() < cooldownUntil) return false
  const playing = syncPlayEpoch()
  if (playing && !probeDuringPlayback) return false
  return true
}

function scheduleResume(): void {
  if (typeof window === 'undefined') return
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    window.dispatchEvent(new Event('thumb-probes-resume'))
  }, SEEK_COOLDOWN_MS + 50)
}

export function abortThumbnailProbes(reason: string): void {
  abortEpoch++
  cooldownUntil = Date.now() + SEEK_COOLDOWN_MS
  const active = activeAbort
  activeAbort = null
  if (active) active.abort(reason)
  scheduleResume()
}

if (typeof window !== 'undefined') {
  window.addEventListener('media-seek', () => abortThumbnailProbes('seek'))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      suspended = true
      abortThumbnailProbes('hidden')
    } else {
      suspended = false
      window.dispatchEvent(new Event('thumb-probes-resume'))
    }
  })
}

// An element parked at a non-zero position must never coexist with a live
// track/anchor session: iOS merges the two timelines, the lock-screen seekto
// stops reaching us and play()/swap wedges follow. Views stop STARTING probes
// while playing, but an in-flight probe would keep parking — abort it the
// instant playback starts or the loaded track changes (a tap without autoplay
// still swaps the engine element).
usePlayerStore.subscribe((state, prev) => {
  if (state.isPlaying !== prev.isPlaying) {
    seeklessAttempted.clear()
    if (state.isPlaying) abortThumbnailProbes('playing')
  } else if (state.currentTrackIndex !== prev.currentTrackIndex && !state.isPlaying) {
    abortThumbnailProbes('track-change')
  }
})

let probeChain: Promise<unknown> = Promise.resolve()

function enqueueProbe<T>(task: () => Promise<T>): Promise<T> {
  const run = probeChain.then(task, task)
  probeChain = run.then(() => undefined, () => undefined)
  return run
}

const inFlight = new Map<string, Promise<string | null>>()

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function getTrackThumbnail(file: File, type: 'audio' | 'video', cacheKey?: string): Promise<string | null> {
  const dedupeKey = cacheKey
  if (dedupeKey !== undefined) {
    await ensureHydrated()
    if (thumbnailCache.has(dedupeKey)) return thumbnailCache.get(dedupeKey) ?? null
  }

  if (type !== 'video') {
    const url = await getAudioThumbnail(file)
    if (dedupeKey !== undefined) cacheInMemory(dedupeKey, url)
    return url
  }

  if (!canProbeNow()) return null
  if (dedupeKey !== undefined) {
    const existing = inFlight.get(dedupeKey)
    if (existing) return existing
    const playing = usePlayerStore.getState().isPlaying
    if (playing && seeklessAttempted.has(dedupeKey)) return null
  }

  const task = (async () => {
    let result: ProbeResult
    try {
      result = await enqueueProbe(() => {
        // Re-check at run time: the queue may have waited behind another probe
        // and a seek / hide may have happened meanwhile.
        if (!canProbeNow()) return Promise.resolve<ProbeResult>({ url: null, mode: 'deferred', attempts: 0, elapsedMs: 0 })
        return getVideoThumbnail(file, { seeklessOnly: usePlayerStore.getState().isPlaying })
      })
    } catch (e) {
      addLog(`thumb ${file.name}: error (${e})`)
      return null
    }

    if (dedupeKey !== undefined && (result.mode === 'seekless-ok' || result.mode === 'seekless-dark')) {
      seeklessAttempted.add(dedupeKey)
    }
    if (result.url && dedupeKey !== undefined) {
      cacheInMemory(dedupeKey, result.url)
      // Frame-0 during playback is provisional: keep it in memory for this
      // session, but do not persist it — the next idle pass seeks for a
      // representative frame and that one becomes permanent.
      if (result.mode !== 'seekless-ok') {
        try { await persistThumbnail(dedupeKey, result.url) } catch (e) { addLog(`thumb: persist failed (${e})`) }
      }
    } else if (!result.url && dedupeKey !== undefined && result.mode.startsWith('unusable')) {
      // Content-based negative result (dark everywhere): persist an empty
      // marker so this file is never probed again. Environment failures
      // (error / timeout / aborted) stay uncached and retry later.
      cacheInMemory(dedupeKey, null)
      try {
        await persistThumbnail(dedupeKey, '')
        addLog(`thumb ${file.name}: marked no-usable-frame (not retried again)`)
      } catch (e) { addLog(`thumb: persist failed (${e})`) }
    }
    return result.url
  })()

  if (dedupeKey !== undefined) {
    inFlight.set(dedupeKey, task)
    void task.finally(() => { inFlight.delete(dedupeKey) })
  }
  return task
}

async function getAudioThumbnail(_file: File): Promise<string | null> {
  // Audio embedded art via jsmediatags not installed yet — fallback to icon
  // To enable: npm i jsmediatags and restore dynamic import with @vite-ignore
  return null
}

// ---------------------------------------------------------------------------
// Video probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  url: string | null
  mode: string
  attempts: number
  elapsedMs: number
}

interface FrameCapture {
  url: string
  mean: number
  stddev: number
}

function getVideoThumbnail(file: File, opts: { seeklessOnly: boolean }): Promise<ProbeResult> {
  const startedAt = Date.now()
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  // Probe hygiene: this element screenshots frames and must never surface
  // anywhere — muted, non-remote, inline, zero volume.
  video.muted = true
  ;(video as unknown as { defaultMuted: boolean }).defaultMuted = true
  try { video.volume = 0 } catch { /* ignore */ }
  try {
    ;(video as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true
  } catch { /* ignore */ }
  video.playsInline = true
  video.setAttribute('webkit-playsinline', 'true')
  video.setAttribute('x-webkit-airplay', 'deny')
  video.preload = 'auto'
  video.src = url

  let finished = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const probeId = ++probeSeq
  const epoch = abortEpoch

  return new Promise<ProbeResult>((resolve) => {
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null }
      try { video.removeAttribute('src'); video.load() } catch { /* ignore */ }
      URL.revokeObjectURL(url)
      if (activeAbort?.id === probeId) activeAbort = null
    }
    const finish = (result: ProbeResult) => {
      if (finished) return
      finished = true
      cleanup()
      const elapsed = Date.now() - startedAt
      addLog(`thumb ${file.name}: ${result.mode} @${elapsed}ms`)
      resolve({ ...result, elapsedMs: elapsed })
    }
    const abort = (reason: string) => finish({ url: null, mode: `aborted:${reason}`, attempts: 0, elapsedMs: 0 })
    activeAbort = { id: probeId, abort }
    timer = setTimeout(() => finish({ url: null, mode: 'load-timeout', attempts: 0, elapsedMs: 0 }), LOAD_TIMEOUT_MS)

    video.addEventListener('error', () => finish({ url: null, mode: 'error', attempts: 0, elapsedMs: 0 }), { once: true })

    const run = async () => {
      if (finished) return
      if (epoch !== abortEpoch) { abort('stale'); return }
      if (timer) { clearTimeout(timer); timer = null }

      // 1) Seekless frame 0: never writes currentTime, so it publishes no
      // non-zero position to the lock screen.
      const first = captureFrame(video)
      const firstUsable = first != null && isUsableFrame(first)
      const firstInfo = first ? `mean ${Math.round(first.mean)} sd ${Math.round(first.stddev)}` : 'no pixels'
      if (opts.seeklessOnly) {
        if (firstUsable && first) finish({ url: first.url, mode: 'seekless-ok', attempts: 0, elapsedMs: 0 })
        else finish({ url: null, mode: 'seekless-dark', attempts: 0, elapsedMs: 0 })
        return
      }

      // 2) Adaptive seek: duration-relative target, reject dark/flat frames,
      // step forward up to MAX_SEEK_ATTEMPTS times. Frame 0 is only a fallback
      // (it is often a title card / logo, not a representative frame).
      const targets = buildSeekTargets(video.duration)
      let attempts = 0
      let bestInfo = firstInfo
      for (const target of targets) {
        if (finished) return
        if (epoch !== abortEpoch) { abort('stale'); return }
        if (!(await seekTo(video, target, SEEK_TIMEOUT_MS))) { attempts++; continue }
        attempts++
        if (finished) return
        const frame = captureFrame(video)
        if (!frame) { bestInfo = `no pixels @${target.toFixed(1)}s`; continue }
        const info = `mean ${Math.round(frame.mean)} sd ${Math.round(frame.stddev)} @${target.toFixed(1)}s`
        bestInfo = info
        if (isUsableFrame(frame)) {
          finish({ url: frame.url, mode: `seek-ok ${info}`, attempts, elapsedMs: 0 })
          return
        }
      }
      if (firstUsable && first) {
        finish({ url: first.url, mode: 'seekless-fallback', attempts, elapsedMs: 0 })
        return
      }
      finish({ url: null, mode: `unusable after ${attempts} seek(s), best ${bestInfo}`, attempts, elapsedMs: 0 })
    }

    video.addEventListener('loadeddata', () => void run(), { once: true })
    video.load()
  })
}

function buildSeekTargets(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0.5) return [0.1]
  const maxT = Math.max(0.1, duration - 0.2)
  const base = duration <= SEEK_MIN_SEC * 2
    ? Math.min(maxT, Math.max(0.1, duration * 0.5))
    : Math.min(SEEK_MAX_SEC, Math.max(SEEK_MIN_SEC, duration * SEEK_DURATION_FRACTION))
  const step = Math.max(1, Math.min(SEEK_STEP_MAX_SEC, duration * SEEK_STEP_FRACTION))
  const out: number[] = []
  for (let i = 0; i < MAX_SEEK_ATTEMPTS; i++) {
    const t = Math.min(maxT, base + step * i)
    if (out.length === 0 || t - out[out.length - 1] > 0.25) out.push(t)
  }
  return out
}

function seekTo(video: HTMLVideoElement, time: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const onSeeked = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      video.removeEventListener('seeked', onSeeked)
      resolve(false)
    }, timeoutMs)
    video.addEventListener('seeked', onSeeked, { once: true })
    try {
      video.currentTime = time
    } catch {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      resolve(false)
    }
  })
}

function captureFrame(video: HTMLVideoElement): FrameCapture | null {
  try {
    const w = video.videoWidth || 0
    const h = video.videoHeight || 0
    if (!w || !h) return null
    const scale = Math.min(1, 320 / w)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const stats = measureFrame(canvas)
    return { url: canvas.toDataURL('image/jpeg', 0.7), ...stats }
  } catch {
    return null
  }
}

function measureFrame(canvas: HTMLCanvasElement): { mean: number; stddev: number } {
  const sw = 32
  const sh = 18
  try {
    const small = document.createElement('canvas')
    small.width = sw
    small.height = sh
    const ctx = small.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { mean: 128, stddev: 32 }
    ctx.drawImage(canvas, 0, 0, sw, sh)
    const data = ctx.getImageData(0, 0, sw, sh).data
    let sum = 0
    let sumSq = 0
    const n = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      sum += luma
      sumSq += luma * luma
    }
    const mean = sum / n
    const variance = Math.max(0, sumSq / n - mean * mean)
    return { mean, stddev: Math.sqrt(variance) }
  } catch {
    // Tainted canvas / read failure: accept the frame rather than discard it.
    return { mean: 128, stddev: 32 }
  }
}

function isUsableFrame(frame: FrameCapture): boolean {
  if (frame.mean >= DARK_MEAN && frame.mean <= BRIGHT_MEAN && frame.stddev >= MIN_STDDEV) return true
  if (frame.mean < DARK_MEAN && frame.stddev >= DARK_DETAIL_STDDEV) return true
  return false
}
