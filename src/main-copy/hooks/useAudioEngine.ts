import { useRef, useEffect, useCallback, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import type { Track } from '../lib/types'
import { queueKey } from '../lib/queue'
import { getTrackFileURL, getCachedTrackUrlSync, isCachedTrackUrl, setActiveTrackUrl } from '../lib/idb'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'
import { isVideoPausedMode, isVideoDelayedStart, isLockWarmCycle, getWarmCycleDelay } from '../lib/mediaFlags'
import { createSilentWavUrl, describeSilentWav } from '../lib/silentAudio'
import { getPlayingArtwork } from '../lib/artwork'

/*
  FINAL — Same-element source swap (Arena idea + your 0.0000001 tweak).

  Why this wins over old anchor handoff / single-element freeze:
  - PWA iOS grants background permission per HTMLMediaElement. Cross-element play() (track <-> anchor)
    is often rejected as AbortError in standalone. Same permanent <audio> swapping src track <-> silent placeholder
    keeps the activation because play() happens synchronously in the MediaSession callback before any await.
  - Silent placeholder is duration-matched (no 2s loop snap) and HOLD_RATE 0.0000001 (your test: 0.25 still drifted, 1e-7 = 4 months per second)
  - Memory: 1 placeholder at a time (~2MB for 125s), revoked when not active, not IndexedDB — 5h track 28125KB still only 0.5s swap, no storage bloat

  States on one element: idle -> track (playing) -> anchor (paused, silent keeps session) -> track (resume)
  Logs: track resumed @ X / track → placeholder @ X / anchor source active @ X

  Video: muted <video> plays alongside <audio> (native 30fps). No continuous sync —
  VideoSyncController was removed (caused stutter/seek storms). Only recalibration is
  on visibility return (hidden pauses video, visible does one drift>0.15 seek).
*/

const HOLD_RATE = 0.0000001
const FALLBACK_HOLD_RATE = 0.0625
// HOLD_RATE 1e-7 keeps bar frozen (~4 months/sec) while anchor holds session; 0 made bar drift to end (see 13:44 logs)

/* ============================================================
   ARENA ENGINE PORT (round-8 winning combo, all pinned ON):
   - playbackState: NO-PAUSED — the anchor declares "playing"
     (it IS playing silence). Declaring it "paused" produced
     declared/icon mismatch loops (the triple-tap) on iOS 27.2.
     The ONE exception: a PARKED navigation anchor (user paused
     by intent) declares "paused" so the lock shows > and one
     press resumes the real track.
   - echo gate: a pause press while hidden + anchored is bug
     305592's echo dispatch — ignored, never a resume (resuming
     would steal the session back = the YouTube tussle). This
     gate is the round-8 load-bearing requirement.
   - resilient presses: BOTH center buttons are engine-aware
     (route via remotePauseOrResume), never literal.
   - Windows/desktop: freeze hold instead of the src-swap
     anchor (muted, rate~0, no swap — sidesteps the desktop
     src-swap repeat loop); a pause press there = resume
     (Chromium derives the icon from the playing-muted element).
   - parked navigation: non-autoplay loads re-anchor with a
     duration-matched WAV so the session survives; a play
     intent makes the real track take over instead.
   The mediaFlags experiments (resilient/echo-aware/warm-cycle
   toggles) are retired for the session layer; UI toggles stay
   but no longer change these behaviors.
   ============================================================ */
const OWN_PAUSE_ECHO_MS = 1500
/** Desktop/Windows freeze hold: element keeps playing muted at rate ~0. */
const FROZEN_VOLUME = 0.001

/** Apple-mobile Safari is the only platform where the PWA session-kill timer
 *  makes the silent-anchor keep-alive necessary (verified rounds 6-8). */
const IS_APPLE_MOBILE = /iP(hone|od|ad)/.test(navigator.userAgent)

function setRate(el: HTMLMediaElement, rate: number) {
  try { el.defaultPlaybackRate = rate; el.playbackRate = rate } catch {
    try { el.defaultPlaybackRate = FALLBACK_HOLD_RATE; el.playbackRate = FALLBACK_HOLD_RATE } catch { /* ignore */ }
  }
}

function setAudioSessionType() {
  const nav = navigator as unknown as { audioSession?: { type: string } }
  if (nav.audioSession) { try { nav.audioSession.type = 'playback' } catch { /* ignore */ } }
}
function hideOffscreen(el: HTMLElement) {
  Object.assign(el.style, { position: 'fixed', left: '-2px', top: '-2px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' } as CSSStyleDeclaration)
}
function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!('mediaSession' in navigator)) return
  if (!Number.isFinite(duration) || duration <= 0) return
  try { navigator.mediaSession.setPositionState({ duration, playbackRate, position: Math.min(Math.max(0, position), duration) }) } catch { /* ignore iOS during transition */ }
}
function getLockPlaybackState(kind: 'track' | 'anchor'): MediaSessionPlaybackState {
  // No-paused posture (arena round-8 winner): BOTH kinds declare "playing".
  // The parked navigation anchor overrides to "paused" at its call sites.
  void kind
  return 'playing'
}
function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

// iOS can leave media.play() unsettled FOREVER after a pipeline wedge
// (observed: one hung promise held the swap mutex ~40s — every later press
// collapsed into a queued command, stale audio under new video, unpausable).
// Bound it: a timeout converts wedge → ordinary failure → guarded retry. 500ms
// (device-tested 7/7 clean, no over-correction): healthy swaps settle in <1s
// even throttled; a false positive costs one extra swap cycle, not breakage —
// the guarded retry simply re-runs. Watch name-vs-duration on lock screen:
// a mismatch means audio belongs to the duration's track, still catching up.
const PLAY_TIMEOUT_MS = 500
async function awaitPlay(p: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      p,
      new Promise<void>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what} timed out after ${PLAY_TIMEOUT_MS}ms`)), PLAY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type SourceKind = 'track' | 'anchor'

export function useAudioEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  const anchorUrlRef = useRef('')
  const anchorForDurationRef = useRef(0)

  const frozenPosRef = useRef(0)
  const trackDurationRef = useRef(0)
  const transitionRef = useRef(false)
  const transitionTokenRef = useRef(0)
  // Echo-aware toggle state: timestamp of our own pause actions vs the last
  // external native pause event (no own action within OWN_PAUSE_ECHO_MS).
  const lastOwnPauseAtRef = useRef(0)
  const lastExternalPauseAtRef = useRef(0)
  // Experiment 7 guard: the synthetic pause→play warm pair must not flip
  // store state or feed the external-pause detector.
  const warmCycleRef = useRef(false)
  // Experiment 8 state: token invalidating stale armed resumes — RETIRED with
  // the arena port (the simple echo gate + engine-aware presses replace the
  // armed-resume machinery; round 8 verified the simple gate wins).
  // ARENA PORT: sticky play intent (true from play request until a real pause;
  // owner flips to idle mid-swap so it cannot answer "was the user playing?")
  const playIntentRef = useRef(false)
  // ARENA PORT: parked navigation anchor — paused by intent, declares "paused",
  // re-anchored per track so the session survives; any press there resumes.
  const pausedParkRef = useRef(false)
  const queuedCommandRef = useRef<'play' | 'pause' | null>(null)
  // Swap serialization: rapid lock-screen next/prev (<1s apart) used to overlap
  // src swaps on the one element — each media.load() aborts the previous
  // play(), blob URLs get revoked mid-flight (NotSupportedError/code 4), and
  // iOS drops the session. Swaps now queue behind a mutex; superseded requests
  // skip instead of interleaving.
  const swapRequestRef = useRef(0)
  const swapTailRef = useRef<Promise<void>>(Promise.resolve())
  const lockSwap = useCallback(() => {
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const prev = swapTailRef.current
    swapTailRef.current = gate
    return prev.then(() => release)
  }, [])
  const commandRunnerRef = useRef<((c: 'play' | 'pause') => void) | null>(null)
  const loadGenRef = useRef(0)
  // Navigation coalescing + rate floor: swaps faster than the pipeline
  // tolerates wedge iOS (NotSupported/code-4 storm, dual-audio crash, session
  // death) — slow taps at ~1Hz are proven clean, sustained 3Hz+ is not. The
  // INDEX always moves (UI stays live) but swaps run at most ~1.3Hz; anything
  // faster collapses into ONE paced catch-up for the final index. Direct
  // resumes (no src change) and pauses stay unthrottled — instant.
  const SWAP_FLOOR_MS = 750
  const lastSwapAttemptRef = useRef(0)
  const loadActiveRef = useRef(false)
  const pendingNavRef = useRef(false)
  const settledIndexRef = useRef(-1)
  const prevTrackIdRef = useRef<string | null>(null)
  const prevFileNameRef = useRef<string | null>(null)
  const nextGestureRef = useRef(false)

  const sourceKindRef = useRef<SourceKind>('track')
  const ownerRef = useRef<'idle' | 'track' | 'anchor' | 'frozen'>('idle')
  const pendingAnchorPosRef = useRef<number | null>(null)

  const { currentTrackIndex, queue, volume, isMuted, setPlaying, setCurrentTime, setDuration, setCurrentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]
  const [loadForce, setLoadForce] = useState(0)

  const attachVideo = useCallback((url: string) => {
    let v = videoRef.current
    if (!v) {
      v = document.createElement('video')
      v.muted = true; (v as unknown as { defaultMuted: boolean }).defaultMuted = true
      // Belt and suspenders: the display video must NEVER sound (route changes
      // on iOS can drop `muted`, which reads as two tracks restarting at once).
      try { v.volume = 0 } catch { /* ignore */ }
      v.playsInline = true; v.setAttribute('webkit-playsinline','true'); v.setAttribute('x-webkit-airplay','deny'); v.preload='auto'; v.controls=false
      try { (v as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true } catch {}
      v.style.width='100%'; v.style.height='100%'; v.style.objectFit='contain'; v.style.background='#000'
      videoRef.current = v
    }
    const c = videoContainerRef.current
    if (c && v.parentNode !== c) { c.innerHTML=''; c.appendChild(v) }
    // Universal reset: always reload even if same src so same-track tap restarts fresh
    v.src = url; v.load()
    try { v.currentTime = 0 } catch {}
    v.pause()
  }, [])
  const detachVideo = useCallback(() => { const v=videoRef.current; if(!v) return; v.pause(); v.removeAttribute('src'); v.load() }, [])
  const cleanupVideo = useCallback(() => { if (videoRef.current) { const v=videoRef.current; v.pause(); v.removeAttribute('src'); v.load(); if(v.parentNode) v.parentNode.removeChild(v); videoRef.current=null } }, [])

  // Video starts ONLY when frames are actually available. A stalled v.play()
  // (contended decoder at boot or under swap churn) leaves a frozen timeline
  // that iOS merges with the audio on the lock screen — the phantom second bar
  // / seek fighting (video-only tracks, self-heals when the decoder frees up,
  // cleared by switching to audio which detaches the video). Fallback is a
  // paused, seek-framed picture: never a stuck playing timeline.
  const maybePlayVideo = useCallback((pos: number) => {
    const v = videoRef.current
    if (!v || !v.src) return
    v.muted = true
    // Experiment 1 "Video paused mode" — checked FIRST so it governs every
    // path (delayed start included): v.play() of the mask is the actual
    // poisoned-lock event (test: locking before the 12s delayed start was
    // healthy 10/10; after the video played, every lock wedged). When this is
    // on the video only ever frames; the audio is re-asserted as the last
    // touched element so the lock session lands on audio.
    if (isVideoPausedMode()) {
      const frame = () => { try { if (Math.abs((v.currentTime || 0) - pos) > 0.05) v.currentTime = pos } catch { /* ignore */ } }
      if (v.readyState >= 3) frame()
      else v.addEventListener('canplay', frame, { once: true })
      addLog('video paused mode: framed, video not playing')
      // Last-touched-element re-assert. Skipped when iOS paused the audio
      // natively (interruption) — never re-assert against that.
      window.setTimeout(() => {
        const m = mediaRef.current
        if (m && sourceKindRef.current === 'track' && !m.paused) {
          void m.play().then(() => addLog('video paused mode: audio re-assert (session on audio)')).catch(() => {})
        }
      }, 250)
      return
    }
    // Experiment 4 (EventLog "Video delayed start"): establish the session on
    // audio ALONE — frame the mask but keep it paused for the first ~12s, then
    // start the in-app video. If the dual-play wedge is born at establishment,
    // the lock stays healable while the video comes back. Guards at fire time:
    // never start while hidden (the lock screen must never see a playing
    // video), never against a paused/interrupted audio, never for a stale src
    // (track already changed underneath us).
    if (isVideoDelayedStart()) {
      const frameNear = (p: number) => { try { if (Math.abs((v.currentTime || 0) - p) > 0.05) v.currentTime = p } catch { /* ignore */ } }
      addLog('video delayed start: framing; video starts in 12s if still in-app playing')
      if (v.readyState >= 3) frameNear(pos)
      else v.addEventListener('canplay', () => frameNear(pos), { once: true })
      window.setTimeout(() => {
        const m = mediaRef.current
        if (document.visibilityState !== 'visible') { addLog('video delayed start: skipped (hidden — lock safe)'); return }
        if (!m || m.paused || sourceKindRef.current !== 'track') { addLog('video delayed start: skipped (audio not playing)'); return }
        const blobNow = blobUrlRef.current || ''
        if (blobNow && v.src !== blobNow && v.currentSrc !== blobNow) { addLog('video delayed start: skipped (track changed)'); return }
        const livePos = m.currentTime
        frameNear(livePos)
        v.play().then(() => addLog('video delayed start: video playing')).catch(() => addLog('video delayed start: play failed (stays framed)'))
      }, 12000)
      return
    }
    const go = () => {
      try {
        if (Math.abs((v.currentTime || 0) - pos) > 0.05) v.currentTime = pos
      } catch { /* ignore */ }
      v.play().catch(() => {
        // Stall: stay paused on the framed position (no competing timeline).
        try {
          v.pause()
          v.currentTime = pos
        } catch { /* ignore */ }
        addLog('video start stalled — framed paused instead')
      })
    }
    if (v.readyState >= 3) {
      go()
    } else {
      const timer = setTimeout(() => {
        v.removeEventListener('canplay', go)
        try {
          v.currentTime = pos
        } catch { /* ignore */ }
        addLog('video not ready in time — framed paused instead')
      }, 1500)
      v.addEventListener('canplay', () => {
        clearTimeout(timer)
        go()
      }, { once: true })
    }
  }, [])

  // Re-asserted ~4Hz: iOS route changes (headphone connect/disconnect) can drop
  // the video element's muted flag, which then sounds as a second restarting
  // track next to the real audio. Cheap property check, no-op when already set.
  const assertVideoSilent = useCallback(() => {
    const vv = videoRef.current
    if (vv && (!vv.muted || vv.volume !== 0)) { try { vv.muted = true; vv.volume = 0 } catch { /* ignore */ } }
  }, [])

  const setOwner = useCallback((o: 'idle' | 'track' | 'anchor' | 'frozen') => { ownerRef.current = o }, [])

  const ensureAnchor = useCallback((trackDuration: number) => {
    const target = Math.max(2, Number.isFinite(trackDuration) ? trackDuration : 2)
    if (anchorUrlRef.current && Math.abs(anchorForDurationRef.current - target) < 0.2) return
    addLog(`building same-element placeholder ${describeSilentWav(target)}`)
    const nextUrl = createSilentWavUrl(target)
    const prev = anchorUrlRef.current
    anchorUrlRef.current = nextUrl
    anchorForDurationRef.current = target
    if (prev && sourceKindRef.current !== 'anchor') URL.revokeObjectURL(prev)
  }, [])

  const flushQueued = useCallback(() => {
    const c = queuedCommandRef.current; queuedCommandRef.current = null
    if (c) queueMicrotask(() => commandRunnerRef.current?.(c))
  }, [])

  const activateSourceInner = useCallback(async (kind: SourceKind, url: string, position: number) => {
    const media = mediaRef.current
    if (!media || !url) throw new Error('media or source missing')
    const token = ++transitionTokenRef.current
    sourceKindRef.current = kind
    setOwner('idle')
    setAudioSessionType()
    const rate = kind === 'anchor' ? HOLD_RATE : 1
    const isVideoTrack = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
    const v = videoRef.current
    // Ensure video is in correct paused/playing state immediately (fix: video kept playing after 2nd lock pause)
    if (isVideoTrack && v) {
      if (kind === 'anchor') { try { v.pause(); v.currentTime = frozenPosRef.current } catch {} }
      else { v.muted = true }
    } else if (v && kind === 'anchor') {
      try { v.pause() } catch {}
    }
    const setPosWhenReady = () => {
      if (token !== transitionTokenRef.current) return
      const srcDur = media.duration
      const safeMax = Number.isFinite(srcDur) ? Math.max(0, srcDur - 0.35) : position
      const safePos = Math.min(Math.max(0, position), safeMax)
      try { media.currentTime = safePos } catch { /* canplay retry */ }
      setRate(media, rate)
      if (v) setRate(v, 1)
    }
    // Audio: keep only single seek before play (play:182) + anchor listeners. No double seek for track.
    if (kind === 'anchor') {
      media.addEventListener('loadedmetadata', setPosWhenReady, { once: true })
      media.addEventListener('canplay', setPosWhenReady, { once: true })
    }
    media.autoplay = true; setRate(media, rate)
    media.src = url; media.load()
    // Video keeps its own track src — never load the silent anchor WAV into <video>
    // (that was the black-screen-on-pause-outside bug: anchor swap clobbered v.src,
    // resume restored it, so it looked like it "fixed itself" on unpause).
    // On anchor→track resume v.src is ALREADY the track blob (anchor no longer clobbers),
    // so skip v.load() to avoid flash-of-old-frame + black reload. Only reload on real
    // track change (different URL). Pre-seek before play so first shown frame is correct.
    if (isVideoTrack && v && kind === 'track') {
      const curSrc = v.currentSrc || v.src || ''
      if (!curSrc || curSrc !== url) {
        v.src = url; v.load()
        try { v.currentTime = position } catch { /* metadata not ready — post-play seek catches it */ }
      } else {
        try { if (Math.abs((v.currentTime || 0) - position) > 0.05) v.currentTime = position } catch {}
      }
    }
    if (kind === 'track' && Math.abs((media.currentTime || 0) - position) > 0.15) try { media.currentTime = position } catch {}
    // Sync lock UI before await to keep PWA gesture — must match final state (fix iOS 26.2 inverted icon)
    // For iOS 26.2, also publish position BEFORE state so bar and icon stay in sync
    const preDuration = trackDurationRef.current || media.duration || position
    if (kind === 'anchor') {
      publishPosition(preDuration, frozenPosRef.current, HOLD_RATE)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
      addLog(`pre-publish anchor ${getLockPlaybackState('anchor')} dur=${preDuration.toFixed(1)} pos=${frozenPosRef.current.toFixed(2)} rate=${HOLD_RATE}`)
    } else {
      publishPosition(preDuration, position, 1)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
      addLog(`pre-publish track ${getLockPlaybackState('track')} dur=${preDuration.toFixed(1)} pos=${position.toFixed(2)} rate=1`)
    }
    const playPromise = media.play()
    // Dual-play only when frames are ready (maybePlayVideo): a stalled video
    // registers a frozen timeline with iOS = lock-screen seek fighting.
    // Keep muted so iOS keeps the audio session.
    if (isVideoTrack && v && kind === 'track') { maybePlayVideo(media.currentTime) }
    else if (v && kind === 'anchor') { try { v.pause() } catch {} }
    try {
      await awaitPlay(playPromise, `${kind} play()`)
    } catch (e) {
      // iOS PWA may reject if not in gesture — log and re-throw for retry in caller
      addLog(`${kind} play() rejected: ${e}`)
      // Round 17: a play() TIMEOUT under hidden spam is not proof of failure —
      // the promise resolution is starved by the handler/metadata churn while
      // the element actually plays (device log 11:15:54: "play() timed out"
      // rejected, then "native playing (track, same element)" immediately
      // after). src was already set (line above), so if the element is
      // sounding, treat as success: no fail count, no stand-down, and the
      // post-publish below publishes the CORRECT duration — the stale-token
      // abandon that previously followed a timeout was half of the sticky
      // track (new name + old duration on the lock).
      const timedOut = e instanceof Error && /timed out/.test(e.message)
      if (timedOut && !media.paused && !media.ended) {
        swapFailsRef.current = 0
        addLog('play() promise starved but element sounding — counted as success')
      } else {
        // Round 16: NotAllowedError = the element lacks activation AND the call
        // ran outside a gesture stack (e.g. the post-rebuild reload, or the
        // recovery load). NOT a pipeline wedge — counting it as a swap failure
        // triggered pointless extra rebuilds and left the engine wedged-looking.
        // Any user press (a gesture) plays the loaded track.
        if (e instanceof DOMException && e.name === 'NotAllowedError') {
          swapFailsRef.current = 0
          throw e
        }
        if (e instanceof DOMException && e.name === 'NotSupportedError') {
          // Wedged pipeline (error state persists across swaps and eventually
          // costs the session): hard-reset so the next swap starts clean. The
          // guarded caller retry re-sets src ~120-500ms later.
          try {
            media.removeAttribute('src')
            media.load()
          } catch {
            /* ignore */
          }
          addLog('media element hard-reset after NotSupportedError')
        }
        // Three consecutive swap failures = wedged element (only a force-close
        // used to recover). Rebuild it; the guarded retry then runs fresh.
        if (++swapFailsRef.current >= 3) {
          addLog(`${swapFailsRef.current} consecutive swap failures — rebuilding element`)
          try {
            rebuildMediaElement()
          } catch {
            /* ignore */
          }
        }
        throw e
      }
    }
    if (token !== transitionTokenRef.current) {
      // Stale: still ensure lock shows correct final kind for the newer token
      addLog(`activateSource ${kind} stale token ${token} abandoned`)
      return
    }
    if (kind === 'anchor') setPosWhenReady()
    setOwner(kind)
    noteSwapSuccess()
    if (kind === 'track') {
      // Ensure video is seeked to same position as audio (fix: video gets ahead after lock resume)
      if (isVideoTrack && v) {
        try { if (Math.abs(v.currentTime - media.currentTime) > 0.15) v.currentTime = media.currentTime } catch {}
      }
      setPlaying(true);
      const postDur = media.duration || trackDurationRef.current
      publishPosition(postDur, media.currentTime, 1)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
      addLog(`post-publish track ${getLockPlaybackState('track')} dur=${postDur.toFixed(1)} pos=${media.currentTime.toFixed(2)} rate=1 state=${getLockPlaybackState('track')}`)
      // Video already handled pre-play (maybePlayVideo); no catch-up play here —
      // a late v.play() is exactly what wedges a frozen competing timeline.
    } else {
      setPlaying(false);
      const postDur = trackDurationRef.current || media.duration
      publishPosition(postDur, frozenPosRef.current, HOLD_RATE)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
      addLog(`post-publish anchor ${getLockPlaybackState('anchor')} dur=${postDur.toFixed(1)} pos=${frozenPosRef.current.toFixed(2)} rate=${HOLD_RATE} state=${getLockPlaybackState('anchor')}`)
      if (v) try { v.pause(); v.currentTime = frozenPosRef.current } catch {}
    }
    // ARENA PORT: publish ONCE after the swap settles. The iOS 26.2-era
    // 120ms/500ms re-publish timers are retired — on 27.2 extra
    // playbackState/positionState churn feeds the mismatch loops (round-8
    // finding), and arena publishes exactly once with clean results.
    addLog(`${kind} source active on permanent element @ ${media.currentTime.toFixed(2)}s${isVideoTrack && kind==='track' ? (v && !v.paused ? ' +video playing' : ' +video paused') : ''} owner=${kind}`)
  }, [setOwner, setPlaying, maybePlayVideo])

  const activateSource = useCallback(async (kind: SourceKind, url: string, position: number) => {
    // Last-wins + serialized: a newer request may arrive while an older one
    // still holds (or waits for) the mutex — the older one skips on entry.
    const myReq = ++swapRequestRef.current
    const release = await lockSwap()
    try {
      if (myReq !== swapRequestRef.current) {
        addLog(`activateSource ${kind} superseded before lock — skipping`)
        return
      }
      return await activateSourceInner(kind, url, position)
    } finally {
      release()
    }
  }, [activateSourceInner, lockSwap])

  const play = useCallback(async () => {
    const state = usePlayerStore.getState()
    const track = state.queue[state.currentTrackIndex] ?? currentTrack
    const media = mediaRef.current
    if (!track || !media) { addLog(`play ignored — no track (queue ${state.queue.length} idx ${state.currentTrackIndex})`); return }
    // ARENA PORT: any play intent leaves the parked state and is sticky until
    // a real pause (the paced catch-up reads this at fire time).
    playIntentRef.current = true
    pausedParkRef.current = false
    if (pendingAnchorPosRef.current !== null) {
      const pend = pendingAnchorPosRef.current
      pendingAnchorPosRef.current = null
      addLog(`play cancels deferred anchor @ ${pend.toFixed(2)} -> resume track`)
      setPlaying(true)
      publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
      try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing' } catch {}
      // Resume track audio that was paused for deferred
      try { await media.play() } catch (e) { addLog(`cancel deferred play failed ${e}`) }
      const vResume = videoRef.current; if (vResume && vResume.src) { try { vResume.currentTime = frozenPosRef.current } catch {}; vResume.muted = true; vResume.play().catch(() => {}) }
      return
    }
    if (transitionRef.current) { queuedCommandRef.current = 'play'; addLog('play queued behind swap'); return }
    transitionRef.current = true
    try {
      const resumePos = frozenPosRef.current
      // Same track, same src — direct resume keeps gesture (no source swap)
      const currentBlobIsTrack = blobUrlRef.current && media.src === blobUrlRef.current
      const isVideoResume = track.mediaType === 'video'
      const vResume = videoRef.current
      if (sourceKindRef.current === 'track' && currentBlobIsTrack) {
        setAudioSessionType()
        if (!IS_APPLE_MOBILE) {
          // Restore the Windows freeze-hold posture (muted/low-rate) before resume.
          const st = usePlayerStore.getState()
          try { media.volume = st.isMuted ? 0 : st.volume } catch { /* ignore */ }
          setRate(media, 1)
        }
        if (Number.isFinite(resumePos) && Math.abs((media.currentTime || 0) - resumePos) > 0.15) try { media.currentTime = resumePos } catch {}
        // Ensure video seeked to resumePos before play (fix ahead after lock resume)
        if (isVideoResume && vResume && vResume.src) {
          try { if (Math.abs(vResume.currentTime - resumePos) > 0.15) vResume.currentTime = resumePos } catch {}
        }
        // Publish before state for iOS sync
        publishPosition(media.duration || trackDurationRef.current, resumePos, 1)
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        addLog(`direct resume pre-publish ${getLockPlaybackState('track')} pos=${resumePos.toFixed(2)}`)
        const directPlay = media.play()
        // Gated like swaps: a stalled video start wedges a frozen timeline.
        if (isVideoResume && vResume && vResume.src) { maybePlayVideo(resumePos) }
        await awaitPlay(directPlay, 'direct resume play()')
        // Baseline 1: no video hardSync
        setOwner('track'); setPlaying(true)
        publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        addLog(`track resumed on permanent element @ ${media.currentTime.toFixed(2)}s rate=1 state=${getLockPlaybackState('track')} direct`)
        // ARENA PORT: no corrective re-publish here (churn retired — arena
        // publishes once per activation).
      } else {
        // Need src swap — ensure blob URL for track
        let url = blobUrlRef.current
        // If blob was revoked or fileName changed, re-derive
        if (!url || prevFileNameRef.current !== track.fileName) {
          if (blobUrlRef.current && !isCachedTrackUrl(blobUrlRef.current)) URL.revokeObjectURL(blobUrlRef.current)
          const fresh = await getTrackFileURL(track.fileName)
          if (!fresh) { showError(`File not found: ${track.fileName}`); throw new Error('no url') }
          blobUrlRef.current = fresh; url = fresh; setActiveTrackUrl(fresh)
        }
        // Snapshot the newest request id: a blind retry after AbortError would
        // otherwise swap a STALE track back over whatever superseded it.
        const mySwapReq = swapRequestRef.current
        try { await activateSource('track', url, resumePos) } catch (e) {
          addLog(`track source swap play() failed: ${e}`)
          // NotSupportedError means a wedged pipeline — give it longer to
          // settle after the hard-reset above before the single retry.
          const hardFail = `${e}`.includes('NotSupportedError')
          await delay(hardFail ? 500 : 120)
          // Retry only if nothing newer arrived meanwhile — a stale retry
          // would swap BACK over the newer track (same storm as the bug).
          if (swapRequestRef.current === mySwapReq) {
            await activateSource('track', url, resumePos)
          } else {
            addLog('track source swap retry skipped (superseded)')
          }
        }
      }
    } catch (e) { setPlaying(false); setOwner('idle'); addLog(`resume failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, currentTrack, flushQueued, setOwner, setPlaying, maybePlayVideo])

  const pause = useCallback(async () => {
    const media = mediaRef.current
    if (!media) return
    playIntentRef.current = false
    if (sourceKindRef.current === 'anchor' || pendingAnchorPosRef.current !== null) {
      // ARENA PORT resilient semantics: a pause press reaching the anchor is
      // the user's resume intent (the placeholder plays silence; iOS shows ||;
      // the echo gate has already filtered the hidden echoes upstream).
      addLog('pause while placeholder/pending → resume (arena port)')
      void play()
      return
    }
    if (transitionRef.current) { queuedCommandRef.current = 'pause'; addLog('pause queued'); return }
    // Own action: the anchor swap stops the track — this is OUR pause, never
    // an external one (the echo-aware external-pause detector relies on it).
    lastOwnPauseAtRef.current = performance.now()
    const pos = media.currentTime
    frozenPosRef.current = pos; setCurrentTime(pos); setPlaying(false)
    const vPause = videoRef.current
    if (vPause) try { vPause.pause() } catch {}
    if (!IS_APPLE_MOBILE) {
      // ARENA PORT — Windows/desktop freeze hold: NO swap. The element keeps
      // playing muted at rate ~0 (src untouched), which keeps the session and
      // sidesteps the desktop src-swap repeat loop. Resumes via the direct
      // path (volume/rate restored there); a pause press while frozen is
      // routed to resume by remotePauseOrResume (Chromium derives the icon
      // from the playing-muted element and sends the play key as "pause").
      try { media.volume = FROZEN_VOLUME } catch { /* ignore */ }
      setRate(media, 0)
      try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch {}
      publishPosition(trackDurationRef.current || media.duration, pos, 0)
      setOwner('frozen')
      addLog(`windows freeze hold (muted rate~0, no swap) @ ${pos.toFixed(2)}s`)
      return
    }
    transitionRef.current = true
    try {
      ensureAnchor(trackDurationRef.current || media.duration || 2)
      await activateSource('anchor', anchorUrlRef.current, pos)
      addLog(`track → placeholder swap @ ${pos.toFixed(2)}s`)
    } catch (e) { setOwner('idle'); addLog(`placeholder swap failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, ensureAnchor, flushQueued, play, setOwner, setPlaying, setCurrentTime])

  commandRunnerRef.current = (c) => { if (c === 'play') void play(); else void pause() }
  // In-app ⏯ routes on the REAL playing state, not owner: after a manual
  // visible pause owner is still 'track', so owner-based routing ran pause()
  // again and (with the resilient auto-resume gated off) hit the "ignored"
  // branch — in-app play could never un-pause its own pause.
  const togglePlay = useCallback(() => { if (usePlayerStore.getState().isPlaying) void pause(); else void play() }, [pause, play])
  const remotePauseOrResume = useCallback((press: 'play' | 'pause' = 'play') => {
    // ARENA PORT: BOTH center presses are engine-aware (resilient, pinned) —
    // the press KIND no longer decides the action; engine reality does.
    const media = mediaRef.current
    if (press === 'play') { void play(); return }
    // Windows freeze hold: the element is still PLAYING (muted, rate~0), so
    // Chromium derives its play/pause from the ELEMENT — overriding our
    // declared "paused" (the overlay shows || and routes the PLAY key as
    // "pause"). A pause press while frozen can therefore only be the user's
    // resume intent.
    if (ownerRef.current === 'frozen') { addLog('frozen hold: pause press = resume (Chromium element-derived icon)'); void play(); return }
    // Parked navigation anchor: paused by intent — a pause press = resume.
    if (pausedParkRef.current) { addLog('parked anchor: pause press = resume'); void play(); return }
    // Echo gate (bug 305592, round-8 load-bearing): while hidden, iOS delivers
    // presses as "pause" regardless of the declared state. With the silent
    // anchor holding the position, a hidden pause press can only be an echo —
    // honoring it would swap back to the track = play() DURING an interruption
    // (the audio-session-steal pattern behind the YouTube tussle).
    if (document.visibilityState !== 'visible' && sourceKindRef.current === 'anchor') {
      addLog('echo-gate: pause press while hidden+anchored IGNORED (echo)')
      return
    }
    // Interruption reality: the element is already paused without our request
    // (a takeover killed our play). Re-anchoring a dead track would wedge —
    // concede to the other source.
    if (media && media.paused && sourceKindRef.current === 'track') {
      addLog('remote pause ignored: element already paused (interrupted reality)')
      return
    }
    void pause()
  }, [pause, play])

  const seek = useCallback((time: number) => {
    const media = mediaRef.current; if (!media) return
    // A parked thumbnail probe + a user seek is the exact pair that makes iOS
    // merge two Now Playing timelines. Abort probes the moment a seek starts.
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('media-seek'))
    const trackDur = trackDurationRef.current || media.duration || time
    const clamped = Math.max(0, Math.min(time, trackDur))
    frozenPosRef.current = clamped; setCurrentTime(clamped)
    const srcMax = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.35) : clamped
    try { media.currentTime = Math.min(clamped, srcMax) } catch { /* ignore */ }
    const v = videoRef.current; if (v?.src) try { v.currentTime = clamped } catch {}
    publishPosition(trackDur, clamped, sourceKindRef.current === 'track' ? 1 : media.playbackRate || HOLD_RATE)
    addLog(`seek ${clamped.toFixed(2)}s (source=${sourceKindRef.current})`)
  }, [setCurrentTime])
  const seekRelative = useCallback((d: number) => seek(frozenPosRef.current + d), [seek])
  void seekRelative

  const nextTrack = useCallback(() => {
    const { getNextTrackIndex } = usePlayerStore.getState()
    const n = getNextTrackIndex(); if (n !== null) { nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(n) }
  }, [setCurrentTrackIndex, setPlaying])
  const prevTrack = useCallback(() => {
    const { getPrevTrackIndex, currentTime } = usePlayerStore.getState()
    if (currentTime > 3 || frozenPosRef.current > 3) { seek(0); return }
    const p = getPrevTrackIndex(); if (p !== null) { nextGestureRef.current = true; setPlaying(usePlayerStore.getState().isPlaying || ownerRef.current==='track'); setCurrentTrackIndex(p) }
  }, [seek, setCurrentTrackIndex, setPlaying])

  // goToTrack defined after loadTrack to allow same-index fresh reload
  const markNextGesture = useCallback(() => { nextGestureRef.current = true }, [])

  const handleTrackEnd = useCallback(() => {
    const { getNextTrackIndex, repeatMode } = usePlayerStore.getState()
    addLog(`ended repeat=${repeatMode}`)
    if (repeatMode === 'one') { const m=mediaRef.current; if(m){ m.currentTime=0; frozenPosRef.current=0; setCurrentTime(0); setAudioSessionType(); m.play().catch(e=>addLog(`repeat-one failed: ${e}`)) } return }
    const n = getNextTrackIndex()
    if (n !== null) { addLog(`auto-next ${n}`); nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(n) }
    else { setPlaying(false); // freeze at end to keep session
      const m=mediaRef.current; if(m){ frozenPosRef.current=m.currentTime; setPlaying(false); if('mediaSession'in navigator) navigator.mediaSession.playbackState=getLockPlaybackState('anchor'); addLog('end -> frozen keep-alive') } }
  }, [setCurrentTrackIndex, setPlaying, setCurrentTime])

  // Phase B: warm the URL cache with the ADJACENT tracks after each load so
  // the NEXT next/prev press is a cache-hit zero-await swap even on a first
  // playthrough (background IDB reads — never awaited by the gesture path).
  const preloadAdjacent = useCallback((idx: number) => {
    const q = usePlayerStore.getState().queue
    for (const i of [idx + 1, idx - 1]) {
      const t = q[i]
      if (!t || getCachedTrackUrlSync(t.fileName)) continue
      void getTrackFileURL(t.fileName)
        .then((u) => { if (u) addLog(`preload cached [${i + 1}] ${t.name.slice(0, 24)}`) })
        .catch(() => {})
    }
  }, [])

  const loadTrack = useCallback(async (idx: number) => {
    // Every tap is a fresh start — even same fileName/instanceId dupes (simplifies playlist dupes)
    frozenPosRef.current = 0
    setCurrentTime(0)
    // A new track request moots any deferred visible→hidden anchor pause: without
    // this, play()'s "cancel deferred" shortcut resumes the OLD media.src while the
    // NEW video element already shows the new track (stale playlist audio + library
    // video after pause-then-switch-context).
    if (pendingAnchorPosRef.current !== null) {
      addLog(`loadTrack cancels deferred anchor (track switch ${idx})`)
      pendingAnchorPosRef.current = null
    }
    // Seek media element to 0 so onTimeUpdate updates frozenPosRef to 0 (not stale position)
    const m = mediaRef.current
    if (m && !m.paused) { try { m.currentTime = 0 } catch {} }
    const { queue: q } = usePlayerStore.getState()
    const track = q[idx]; if (!track) return
    // Round 15: hidden stand-down — with 2+ consecutive swap failures while
    // hidden, STOP attempting swaps: each retry deepens the wedge, and the
    // failure storm is what cost sessions (small-library sustained spam). The
    // index change stays pending and is served on visible via the recovery
    // branch (rebuild first if one was deferred).
    if (typeof document !== 'undefined' && document.hidden && swapFailsRef.current >= 2) {
      hiddenRecoveryRef.current = hiddenRecoveryRef.current === 'rebuild' ? 'rebuild' : 'standdown'
      pendingNavRef.current = true
      // Round 16: the metadata push below already advertised the NEW track —
      // with the swap blocked, the lock would show the new name over the old
      // element's audio/duration (the "stuck track" mismatch). Revert the
      // metadata to the SETTLED track so the lock always describes what the
      // element is actually playing.
      const settled = q[settledIndexRef.current]
      if (settled && settled.id !== track.id) {
        try {
          // Round 17: include the app-icon artwork — the artwork-less revert
          // was wiping the lock icon (the "icon gone for a bit" at sticky onset).
          const art = getPlayingArtwork()
          if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: settled.name, artist: settled.artist || 'Unknown Artist', album: settled.album || 'Unknown Album', artwork: [{ src: art, sizes: '300x300', type: 'image/svg+xml' }] })
          addLog(`stand-down: metadata reverted to settled track (lock matches element)`)
        } catch { /* ignore */ }
      }
      addLog(`swap stand-down (hidden, ${swapFailsRef.current} consecutive fails) — recovery on visible`)
      return
    }
    // Coalesce: a swap is running, or the last one started less than a floor
    // interval ago — move the index (already done by caller) but let one paced
    // catch-up serve the final index. Without the floor, back-to-back swaps
    // still hammer src at 3Hz+ and WebKit kills the session anyway.
    const now = performance.now()
    const cooling = loadActiveRef.current || now - lastSwapAttemptRef.current < SWAP_FLOOR_MS
    if (cooling && idx !== settledIndexRef.current) {
      pendingNavRef.current = true
      if (!loadActiveRef.current) {
        // No owner to drain us — schedule the paced catch-up ourselves.
        const wait = Math.max(0, SWAP_FLOOR_MS - (now - lastSwapAttemptRef.current))
        addLog(`swap paced +${Math.round(wait)}ms [${idx + 1}]`)
        setTimeout(() => {
          pendingNavRef.current = false
          const c = usePlayerStore.getState().currentTrackIndex
          if (c !== settledIndexRef.current) void loadTrack(c)
        }, wait)
      } else {
        addLog(`swap coalesced [${idx + 1}] (settle in flight)`)
      }
      return
    }
    lastSwapAttemptRef.current = now
    loadActiveRef.current = true
    const gen = ++loadGenRef.current
    const prevId = prevTrackIdRef.current
    if (prevId && prevId !== track.id) addLog(`track change ${prevId.slice(0,4)} -> ${track.id.slice(0,4)}: will reset pos to 0`)

    // If frozen placeholder active, we'll swap to track — no need to keep HOLD_RATE
    transitionRef.current = false; queuedCommandRef.current = null

    cleanupVideo()
    // Phase B: only revoke URLs the cache doesn't own — cached URLs live until
    // eviction (revoking them would kill a future cache hit mid-playback).
    if (blobUrlRef.current && !isCachedTrackUrl(blobUrlRef.current)) URL.revokeObjectURL(blobUrlRef.current)
    blobUrlRef.current = null

    // Phase B (round 11): cache-first URL. On a hit this is fully SYNCHRONOUS
    // (zero await between gesture and src) — matching arena's zero-await swap
    // stack; a miss still derives via IDB and seeds the cache for next time.
    const cachedUrl = getCachedTrackUrlSync(track.fileName)
    const url = cachedUrl ?? await getTrackFileURL(track.fileName)
    if (cachedUrl) addLog(`load url: cache hit (zero-await) ${track.fileName.slice(0, 28)}`)
    if (gen !== loadGenRef.current) {
      // A newer FULL load owns the future — it drains. Just stand down.
      loadActiveRef.current = false
      addLog(`load [${idx + 1}] stale gen ${gen} abandoned`)
      if (url && !isCachedTrackUrl(url)) URL.revokeObjectURL(url)
      return
    }
    if (!url) {
      loadActiveRef.current = false
      showError(`File not found: ${track.fileName}`)
      drainCoalesced(idx, gen)
      return
    }
    blobUrlRef.current = url
    setActiveTrackUrl(url)
    const el = mediaRef.current
    if (!el) {
      loadActiveRef.current = false
      drainCoalesced(idx, gen)
      return
    }
    if (!IS_APPLE_MOBILE) {
      // ARENA PORT: restore any Windows freeze-hold posture before the fresh
      // load (frozen hold leaves the element muted at rate~0).
      const st = usePlayerStore.getState()
      try { el.volume = st.isMuted ? 0 : st.volume } catch { /* ignore */ }
      setRate(el, 1)
    }
    const instanceId = queueKey(track)
    // Every tap is fresh — always reset time/duration even for same fileName dupes
    setCurrentTime(0); setDuration(0); trackDurationRef.current = 0
    // If media element already has the same src, onLoadedMetadata won't re-fire, so read duration directly
    if (el && Number.isFinite(el.duration) && el.duration > 0) {
      trackDurationRef.current = el.duration
      setDuration(el.duration)
    }
    if (prevId && prevId !== instanceId) addLog(`track change ${prevId.slice(0,4)} -> ${instanceId.slice(0,4)}: fresh load`)
    else if (prevId) addLog(`track restart ${instanceId.slice(0,4)}: fresh load`)
    prevTrackIdRef.current = instanceId
    prevFileNameRef.current = track.fileName

    if (track.mediaType === 'video') attachVideo(url)
    if ('mediaSession' in navigator) {
      const art = getPlayingArtwork()
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist||'Unknown Artist', album: track.album||'Unknown Album', artwork: [{ src: art, sizes:'300x300', type:'image/svg+xml' }] }) } catch {
        try { navigator.mediaSession.metadata = new MediaMetadata({ title: track.name, artist: track.artist||'Unknown Artist', album: track.album||'Unknown Album' }) } catch {}
      }
    }
    setAudioSessionType()
    const { isPlaying: wasPlaying } = usePlayerStore.getState()
    const shouldAutoplay = wasPlaying || nextGestureRef.current
    nextGestureRef.current = false
    // ARENA PORT: sticky intent + parked-state reset for the fresh load.
    playIntentRef.current = shouldAutoplay
    pausedParkRef.current = false
    addLog(`load [${idx+1}/${q.length}] ${track.name} autoplay=${shouldAutoplay} (wasPlaying=${wasPlaying})`)
    preloadAdjacent(idx)
    // Round 17: settledIndexRef must be AUTHORITATIVE — only a swap that
    // actually landed on the element may mark it settled. Previously the drain
    // marked settled even after a failed play(), so (a) the catch-up skip
    // check believed a never-played index was settled, and (b) the round-16
    // stand-down metadata revert targeted the FAILED index — re-pushing the
    // sticky name instead of the sounding track (the revert fired but fixed
    // nothing, exactly as the 11:35 logs show).
    let playOk = false
    if (shouldAutoplay) {
      try {
        await play()
        playOk = true
      } catch {
        /* play() logs + guards itself; drain below still runs */
      }
      await drainCoalesced(idx, gen, playOk)
    } else {
      el.src = url; el.load()
      loadActiveRef.current = false
      pendingNavRef.current = false
      if (gen === loadGenRef.current) settledIndexRef.current = idx
      if (IS_APPLE_MOBILE) {
        // ARENA PORT — paused-navigation keep-alive: a loaded-but-silent
        // element expires the iOS PWA session within seconds. Re-anchor the
        // NEW track (duration-matched WAV) once its metadata lands; a play
        // intent makes the real track take over instead of parking.
        pausedParkRef.current = true
        const reAnchor = () => {
          el.removeEventListener('loadedmetadata', reAnchor)
          const st = usePlayerStore.getState()
          if (st.currentTrackIndex !== idx) return
          if (playIntentRef.current) { addLog('parked skip: play intent arrived → track takes over'); void play(); return }
          void (async () => {
            try {
              ensureAnchor(trackDurationRef.current || el.duration || 2)
              await activateSource('anchor', anchorUrlRef.current, 0)
              if (!playIntentRef.current) {
                try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch {}
                addLog('parked anchor declared paused (one-press resume)')
              }
            } catch (e) { addLog(`parked re-anchor failed: ${e}`) }
          })()
        }
        el.addEventListener('loadedmetadata', reAnchor)
      }
    }
  }, [attachVideo, cleanupVideo, preloadAdjacent, setCurrentTime, setDuration, play])

  // Catch-up drain for coalesced navigation: after a load completes, serve the
  // final index — paced through the same floor (an immediate rerun would
  // defeat it). Gen-guarded so a newer full load (which owns the future)
  // never double-runs.
  async function drainCoalesced(finishedIdx: number, finishedGen: number, playOk = false): Promise<void> {
    loadActiveRef.current = false
    const curIdx = usePlayerStore.getState().currentTrackIndex
    const need = (pendingNavRef.current || curIdx !== finishedIdx) && finishedGen === loadGenRef.current
    pendingNavRef.current = false
    if (!need) {
      // Round 17: playOk gates the settle mark — a failed swap never happened
      // on the element, so the PREVIOUS settled index stays authoritative.
      if (finishedGen === loadGenRef.current && playOk) settledIndexRef.current = finishedIdx
      return
    }
    const wait = SWAP_FLOOR_MS - (performance.now() - lastSwapAttemptRef.current)
    if (wait > 0) {
      pendingNavRef.current = true
      addLog(`catch-up paced +${Math.round(wait)}ms (pipeline floor)`)
      setTimeout(() => {
        pendingNavRef.current = false
        const c = usePlayerStore.getState().currentTrackIndex
        if (c !== settledIndexRef.current) void loadTrack(c)
      }, wait)
      return
    }
    addLog(`catch-up load [${curIdx + 1}] (coalesced during [${finishedIdx + 1}])`)
    return loadTrack(curIdx)
  }

  // goToTrack defined after loadTrack so same-index tap forces fresh reload via useEffect
  const goToTrack = useCallback((i: number) => {
    nextGestureRef.current = true
    setPlaying(true)
    setCurrentTrackIndex(i)
    setLoadForce(v => v + 1)
  }, [setCurrentTrackIndex, setPlaying, setLoadForce])

  // One-shot guard so reorderQueue's index correction doesn't reload audio.
  const suppressReloadRef = useRef(false)

  // Gapless reorder: swaps in a new queue order WITHOUT restarting the sounding
  // track. Mechanism: the load effect below reloads on every index change, so
  // callers pass the sounding occurrence's NEW index and we swallow that one
  // effect run. Shuffle positions are remapped through queueKeys (positional
  // indices would otherwise point at the wrong tracks). The <audio>/<video>
  // elements are never touched — playback continues mid-frame.
  const reorderQueue = useCallback((newQueue: Track[], newIndex: number) => {
    const st = usePlayerStore.getState()
    const oldQueue = st.queue
    const keyToNew = new Map(newQueue.map((t, i) => [queueKey(t), i] as const))
    // The effect below ALWAYS fires after this (monotonic force bump), so arm
    // unconditionally: the sounding audio is already correct for the new order
    // by construction, and any reload here would restart it audibly.
    suppressReloadRef.current = true
    // Monotonic bump (never reset to 0): guarantees exactly one effect run to
    // consume the guard — never leaked into the next tap, never a double load.
    setLoadForce((v) => v + 1)
    // The sounding audio is already correct for the new order — mark settled
    // so a later drain doesn't "catch up" into a redundant reload.
    settledIndexRef.current = newIndex
    st.setQueue(newQueue)
    st.setOriginalOrder(newQueue)
    if (st.shuffleOn) {
      const remapped = st.shuffleOrder
        .map((oldIdx) => {
          const oldItem = oldQueue[oldIdx]
          return oldItem ? (keyToNew.get(queueKey(oldItem)) ?? -1) : -1
        })
        .filter((i) => i >= 0)
      // Keep every position exactly once (dropped indices = removed tracks).
      const seen = new Set(remapped)
      for (let i = 0; i < newQueue.length; i++) if (!seen.has(i)) remapped.push(i)
      st.setShuffleOrder(remapped)
    }
    st.setCurrentTrackIndex(newIndex)
    addLog(`queue reordered (${newQueue.length} tracks, sounding kept @${newIndex})`)
  }, [])

  // Permanent element once
  const makeMediaElement = useCallback(() => {
    const media = document.createElement('audio')
    media.preload = 'auto'; media.controls = true; media.setAttribute('playsinline','true'); media.setAttribute('webkit-playsinline','true'); media.setAttribute('x-webkit-airplay','allow'); (media as unknown as { dataset: Record<string,string> }).dataset.sessionOwner='permanent'
    hideOffscreen(media); document.body.appendChild(media)
    try {
      const st = usePlayerStore.getState()
      media.volume = st.isMuted ? 0 : st.volume
    } catch { /* ignore */ }
    return media
  }, [])

  const wireMediaElement = useCallback((media: HTMLAudioElement) => {

    const onLoadedMetadata = () => {
      if (sourceKindRef.current === 'anchor') return
      const d = media.duration; if (!Number.isFinite(d) || d<=0) return
      trackDurationRef.current = d; setDuration(d); publishPosition(d, media.currentTime, 1)
      // Deferred prebuild: a synchronous multi-MB WAV synthesis per swap is what
      // janks the main thread into a wedge under spam (and cooks the phone).
      // Delay past the coalesce window — spam swaps never pay it; a settled
      // track still has its anchor ready long before anyone pauses. pause()
      // itself always ensures on demand, so early pauses are covered too.
      const builtFor = loadGenRef.current
      const builtKind: SourceKind = sourceKindRef.current as SourceKind
      setTimeout(() => {
        if (loadGenRef.current !== builtFor) return
        if (sourceKindRef.current !== builtKind || sourceKindRef.current !== 'track') return
        ensureAnchor(d)
      }, 800)
    }
    const onPlaying = () => {
      const k = sourceKindRef.current
      if (k==='track') {
        setOwner(k); setPlaying(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track')
        publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
        // Ensure video reflects playing track (fix: video stuck paused after lock resume)
        const v = videoRef.current
        const isVideoTrack = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
        if (isVideoTrack && v && v.src && v.paused) { maybePlayVideo(media.currentTime) }
      } else {
        setOwner(k); setPlaying(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('anchor')
        publishPosition(trackDurationRef.current || media.duration, frozenPosRef.current, HOLD_RATE)
        // Anchor must keep video paused (fix: video kept playing after 2nd lock pause)
        const v = videoRef.current; if (v && !v.paused) try { v.pause() } catch {}
      }
      addLog(`native playing (${k}, same element)`)
    }
    const onPause = () => {
      if (warmCycleRef.current) { addLog('native pause ignored during warm-cycle'); return }
      if (transitionRef.current) {
        // Device-proven: NORMAL swaps emit NO element pause event at all
        // (logs show pre-publish → native playing (anchor), nothing between).
        // A pause DURING our transition is therefore iOS's interruption
        // pausing us mid-swap (it even aborts our play() with AbortError).
        // v1 swallowed this — the exact blind spot that let 1-2s presses
        // resume us and re-assert the track. Record it as external so the
        // 4s gate works for the presses that follow.
        lastExternalPauseAtRef.current = performance.now()
        addLog(`native pause during transition (${sourceKindRef.current}) → recorded as external (echo-aware interruption)`)
        return
      }
      // Echo-aware detection: an element pause WITHOUT our request (no own
      // pause action within OWN_PAUSE_ECHO_MS) is an external native pause —
      // iOS's interruption pausing us. Own echoes (deferred media.pause(),
      // anchor swaps are transition-guarded) must NOT count as external, else
      // all our own pause presses would later be misread as echoes.
      const sinceOwn = performance.now() - lastOwnPauseAtRef.current
      if (sinceOwn >= OWN_PAUSE_ECHO_MS) {
        lastExternalPauseAtRef.current = performance.now()
        addLog('external native pause detected (echo-aware)')
      }
      // Only treat pause as real pause when track was playing; anchor pause is expected to be playing silent
      // ARENA PORT parity (round 11 tussle fix): arena's onPause NEVER writes
      // playbackState. The copy's write here re-asserted "playing" from inside
      // an interruption (the port made it unconditional 'playing') — a
      // declared-vs-element mismatch claim that feeds iOS's reconcile echo,
      // which dispatches play() and steals the session back from the takeover
      // = the track-repeatedly-overrides-YouTube tussle. Store flip only.
      if (sourceKindRef.current==='track' && ownerRef.current==='track') setPlaying(false)
      addLog(`native pause (${sourceKindRef.current})`)
    }
    const onTimeUpdate = () => {
      if (sourceKindRef.current==='track') { if (!transitionRef.current) frozenPosRef.current = media.currentTime; setCurrentTime(media.currentTime); publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1); assertVideoSilent(); return }
      // Best effort: frozen track pos is authoritative even if anchor bar drifts — threshold 0.35 avoids PC constant rewind loop
      const frozen = frozenPosRef.current
      if (media.currentTime - frozen >= 0.35) { try { media.currentTime = Math.min(frozen, Math.max(0, media.duration - 0.35)) } catch {} }
      publishPosition(trackDurationRef.current || media.duration, frozen, media.playbackRate || HOLD_RATE)
      // Keep video paused while anchor (guard against iOS resuming video on visibility)
      const v = videoRef.current; if (v && !v.paused) try { v.pause() } catch {}
    }
    const onEnded = () => {
      if (sourceKindRef.current==='anchor') { const safe=Math.max(0, Math.min(frozenPosRef.current, media.duration-0.35)); media.currentTime=safe; media.play().catch(e=>addLog(`placeholder restart failed: ${e}`)); return }
      handleTrackEnd()
    }
    const onError = () => addLog(`permanent media error: code ${media.error?.code} ${media.error?.message||''}`)
    media.addEventListener('loadedmetadata', onLoadedMetadata); media.addEventListener('durationchange', onLoadedMetadata)
    media.addEventListener('playing', onPlaying); media.addEventListener('pause', onPause)
    media.addEventListener('timeupdate', onTimeUpdate); media.addEventListener('ended', onEnded); media.addEventListener('error', onError)
  }, [ensureAnchor, handleTrackEnd, setDuration, setPlaying, setCurrentTime])

  // Experiment 7 (lock warm-cycle): mimic the autoplay warm-up on every fresh
  // lock. Autoplay during a lock = native element pause (track end) → fresh
  // play (next track) → lock UI fully warm. We deliver pause→play ourselves
  // when the page hides with the track playing: pause now, resume after
  // WARM_CYCLE_DELAY_MS on the SAME src — no swap, no gesture needed (the
  // element is already activated), and warmCycleRef keeps the store state and
  // external-pause detector untouched during the pair.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = () => {
      if (document.visibilityState !== 'hidden' || !isLockWarmCycle()) return
      const media = mediaRef.current
      const st = usePlayerStore.getState()
      if (!media || sourceKindRef.current !== 'track' || ownerRef.current !== 'track') return
      if (!st.isPlaying || media.paused || media.ended) return
      warmCycleRef.current = true
      addLog('warm-cycle: native pause on hidden (lock warm-up)')
      try { media.pause() } catch { /* ignore */ }
      setTimeout(() => {
        warmCycleRef.current = false
        const m = mediaRef.current
        // Resume regardless of visibility: the user can return to the app
        // before the timer fires — the element is OUR pause (warmCycleRef
        // gated the pause event), so playback must be restored either way.
        // Coming back visible simply continues the interrupted warm pair.
        if (!m) return
        if (sourceKindRef.current !== 'track' || ownerRef.current !== 'track') return
        if (!usePlayerStore.getState().isPlaying) return
        addLog(`warm-cycle: native resume (lock warm-up${document.visibilityState === 'visible' ? ', resumed-after-return' : ''})`)
        const p = m.play()
        if (p) p.catch((e) => addLog(`warm-cycle play failed: ${e}`))
      }, getWarmCycleDelay())
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Last-resort recovery: after N consecutive swap failures the element itself
  // is wedged (error state persists — only a force-close used to help). Rebuild
  // it fresh in place (same recipe as boot; blob URLs survive, same document),
  // then reload the current index. Cooldown-guarded against rebuild loops.
  // Round 15: NEVER rebuild while hidden — destroying the session-owning
  // element is exactly what killed the session (small-library sustained-spam
  // death: play() timeouts → hidden rebuild → dead session on return). The
  // wedged element keeps holding the (stale) session until visible; the
  // deferred rebuild then recovers in front of the user.
  const rebuildCountRef = useRef(0)
  const swapFailsRef = useRef(0)
  const lastRebuildAtRef = useRef(0)
  // 'rebuild' = deferred rebuild armed; 'standdown' = hidden swaps stopped.
  const hiddenRecoveryRef = useRef<'none' | 'rebuild' | 'standdown'>('none')
  const noteSwapSuccess = useCallback(() => { swapFailsRef.current = 0 }, [])
  const rebuildMediaElement = useCallback(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      hiddenRecoveryRef.current = 'rebuild'
      addLog('rebuild deferred (hidden) — session survives; recovery on visible')
      return
    }
    const now = performance.now()
    if (now - lastRebuildAtRef.current < 30000) {
      addLog('rebuild skipped (cooldown) — pipeline still failing')
      return
    }
    lastRebuildAtRef.current = now
    const n = ++rebuildCountRef.current
    addLog(`rebuilding media element (#${n}) after repeated swap failures`)
    const old = mediaRef.current
    try {
      if (old) {
        try { old.pause() } catch { /* ignore */ }
        old.removeAttribute('src')
        try { old.load() } catch { /* ignore */ }
        old.remove()
      }
    } catch { /* ignore */ }
    transitionTokenRef.current += 1
    transitionRef.current = false
    queuedCommandRef.current = null
    pendingAnchorPosRef.current = null
    sourceKindRef.current = 'track'
    setOwner('idle')
    swapFailsRef.current = 0
    const fresh = makeMediaElement()
    mediaRef.current = fresh
    wireMediaElement(fresh)
    setAudioSessionType()
    // Round 16: a FRESH element has no activation history — autoplay outside a
    // gesture stack is denied (NotAllowedError, device-proven 21:35 logs).
    // Park the reload instead: the track loads silent and declared paused
    // (parked re-anchor keeps the session), and the user's next press resumes
    // it with a real gesture. This replaces the stuck silent-after-rebuild
    // state that needed a manual pause+unpause.
    setPlaying(false)
    const st = usePlayerStore.getState()
    if (st.queue.length > 0 && st.queue[st.currentTrackIndex]) {
      // Reload current index fresh on the new element (loadTrack respects
      // paused vs playing, so no surprise playback).
      setLoadForce((v) => v + 1)
    }
  }, [makeMediaElement, wireMediaElement, setOwner, setPlaying])

  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean }
    const standalone = (nav as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches
    addLog(`environment: ${standalone ? 'home-screen standalone PWA' : 'browser tab'}; permanent element ready`)
    const media = makeMediaElement()
    mediaRef.current = media
    wireMediaElement(media)
    setAudioSessionType(); addLog('permanent audio element ready (same-element handoff)')
    return () => {
      transitionTokenRef.current+=1; media.pause(); media.removeAttribute('src'); media.load(); media.remove(); mediaRef.current=null
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current); if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [makeMediaElement, wireMediaElement])

  // Re-attach video only on a REAL track change (queueKey + type), not on every
  // queue array identity change: live-append/reorder creates a new array for the
  // SAME sounding track, and re-attaching resets the video to 0/paused (black
  // video while audio continues) until the next pause/resume re-seeks it.
  const queueVideoKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const t = queue[currentTrackIndex]; if (!t) return
    const key = `${queueKey(t)}:${t.mediaType}`
    if (queueVideoKeyRef.current === key) return
    queueVideoKeyRef.current = key
    if (t.mediaType === 'video') attachVideo(blobUrlRef.current || '')
    else detachVideo()
  }, [currentTrackIndex, queue, attachVideo, detachVideo])

  useEffect(() => {
    const onVis = () => {
      addLog(`visibility -> ${document.visibilityState} owner=${ownerRef.current} kind=${sourceKindRef.current} pending=${pendingAnchorPosRef.current} lock=${getLockPlaybackState(sourceKindRef.current as 'track'|'anchor')}`)
      if (document.visibilityState==='hidden') {
        // Pending in-app pause: do real anchor swap while hidden (hidden-created anchor shows > correctly)
        if (pendingAnchorPosRef.current !== null) {
          const pos = pendingAnchorPosRef.current
          pendingAnchorPosRef.current = null
          addLog(`hidden deferred anchor swap @ ${pos.toFixed(2)}`)
          const vPend = videoRef.current; if (vPend) try { vPend.pause(); vPend.currentTime = pos } catch {}
          void (async () => {
            transitionRef.current = true
            try {
              ensureAnchor(trackDurationRef.current || mediaRef.current?.duration || 2)
              await activateSource('anchor', anchorUrlRef.current, pos)
              addLog(`deferred track → placeholder swap @ ${pos.toFixed(2)}s (hidden)`)
            } catch (e) { setOwner('idle'); addLog(`deferred swap failed: ${e}`) }
            finally { transitionRef.current = false; flushQueued() }
          })()
          return
        }
        const vHidden = videoRef.current
        if (vHidden) try { vHidden.pause() } catch {}
        const kindHidden = sourceKindRef.current as 'track'|'anchor'
        if (kindHidden === 'anchor') {
          const dur = trackDurationRef.current || 0
          const pos = frozenPosRef.current
          try {
            publishPosition(dur, pos, HOLD_RATE)
            // Round 13 (arena parity): the non-parked 'playing' re-write is
            // RETIRED. 27.x playbackState writes are native claims
            // (clientWillBeginPlayback — bug 305592 research note), and the
            // state was already declared at anchor activation; re-writing it
            // at hide time is redundant churn. The PARKED case keeps its
            // 'paused' declaration (the one-press-resume contract).
            if (pausedParkRef.current) { try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' } catch {} }
          } catch {}
          addLog(`hidden anchor refresh paused pos=${pos.toFixed(2)} HOLD_RATE`)
          if (vHidden && vHidden.src) try { vHidden.currentTime = pos } catch {}
          // Keep silent anchor playing at HOLD_RATE to keep session (truly paused kills after 30s)
          const mediaHidden = mediaRef.current
          if (mediaHidden && mediaHidden.paused) {
            try { setRate(mediaHidden, HOLD_RATE); mediaHidden.play().then(() => addLog(`hidden anchor resume HOLD_RATE`)).catch(() => {}) } catch {}
          }
        } else {
          const dur = mediaRef.current?.duration || trackDurationRef.current || 0
          const pos = mediaRef.current?.currentTime || 0
          try {
            // Round 13 (arena parity): NO playbackState write on hide — the
            // state was already declared at track activation, and a hide-time
            // 'playing' write is a NATIVE playback claim
            // (clientWillBeginPlayback) issued exactly while the takeover
            // hands the session off = the 1-interruption delta. Arena's hide
            // handler writes nothing at all.
            publishPosition(dur, pos, 1)
          } catch {}
          addLog(`hidden track refresh playing pos=${pos.toFixed(2)}`)
          // Keep video paused while hidden (audio continues), will seek on visible
          if (vHidden && !vHidden.paused) try { vHidden.pause() } catch {}
        }
        return
      }
      setAudioSessionType()
      // Round 15: hidden recovery — serve whatever the stand-down deferred
      // (rebuild first if armed, then the pending index catch-up via the
      // rebuild's own reload / a direct loadTrack).
      if (hiddenRecoveryRef.current !== 'none') {
        const mode = hiddenRecoveryRef.current
        hiddenRecoveryRef.current = 'none'
        pendingNavRef.current = false
        addLog(`hidden recovery on visible: ${mode}`)
        if (mode === 'rebuild') { rebuildMediaElement(); return }
        void loadTrack(usePlayerStore.getState().currentTrackIndex)
        return
      }
      const m=mediaRef.current; const v=videoRef.current
      const isVideo = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
      if (pendingAnchorPosRef.current !== null) {
        addLog(`visible cancel deferred anchor, stay track @ ${m?.currentTime.toFixed(2)}`)
        pendingAnchorPosRef.current = null
        setPlaying(true)
        publishPosition(m?.duration || trackDurationRef.current || 0, m?.currentTime || 0, 1)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing' } catch {}
        if (isVideo && v && v.src) { maybePlayVideo(m?.currentTime || 0) }
        return
      }
      // Anchor must stay paused (fix 2nd lock pause video drift)
      if (sourceKindRef.current === 'anchor' || ownerRef.current === 'anchor') {
        if (v && !v.paused) try { v.pause() } catch {}
        if (v && v.src) try { v.currentTime = frozenPosRef.current } catch {}
        publishPosition(trackDurationRef.current || (m?.duration ?? 0), frozenPosRef.current, HOLD_RATE)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = pausedParkRef.current ? 'paused' : getLockPlaybackState('anchor') } catch {}
        return
      }
      if (ownerRef.current==='track' && m && !m.paused) {
        // Leave-app recalibration only: video paused while hidden, audio continued.
        // No continuous sync (VideoSyncController removed — it caused stutter/seek storms).
        // On return, one drift>0.15 seek re-aligns video to audio; otherwise they stay in sync.
        if (isVideo && v && v.src) {
          const drift = Math.abs(v.currentTime - m.currentTime)
          if (drift > 0.15) {
            try { v.currentTime = m.currentTime; addLog(`visible video seek to audio ${m.currentTime.toFixed(2)} drift ${drift.toFixed(2)}`) } catch {}
          }
          if (v.paused) { maybePlayVideo(m.currentTime) }
        }
        publishPosition(m.duration || trackDurationRef.current, m.currentTime, 1)
        try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = getLockPlaybackState('track') } catch {}
        addLog(`visible track playing seek synced`)
      }
    }
    const onPageShow = (e: PageTransitionEvent) => { setAudioSessionType(); addLog(`pageshow${(e as unknown as { persisted?: boolean }).persisted?' (bfcache)':''}`) }
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pageshow', onPageShow as EventListener)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pageshow', onPageShow as EventListener) }
  }, [activateSource, ensureAnchor, rebuildMediaElement, loadTrack, setPlaying, maybePlayVideo])

  useEffect(() => {
    // loadForce is a monotonic signal (goToTrack bumps per tap); resetting it
    // here retriggered this effect (N+1 → 0 is a change) and loaded EVERY tap
    // twice — the repeat/stutter on all tracks. Never reset; suppress consumes.
    if (suppressReloadRef.current) { suppressReloadRef.current = false; return }
    if (currentTrack && queue.length>0) { void loadTrack(currentTrackIndex) }
  }, [currentTrackIndex, loadForce])
  // Boot probe: the effect above only fires on INDEX change, but boot fills the
  // queue with index already at 0 — so track 1 has no duration/anchor metadata
  // when first played. Probe it with a THROWAWAY element for metadata, but
  // stage the real state too (blob URL + file ref + attached paused video):
  // the permanent <audio> itself stays untouched (no src), so the first Play
  // takes the exact same full-swap path as every other track. Uniform loading
  // killed the first-track-only lock-screen seek fighting. No autoplay: no
  // gesture yet.
  const didBootWarmRef = useRef(false)
  useEffect(() => {
    if (!didBootWarmRef.current && queue.length > 0 && currentTrack) {
      didBootWarmRef.current = true
      const t = currentTrack
      void (async () => {
        const url = await getTrackFileURL(t.fileName).catch(() => null)
        if (!url) return
        const d = await new Promise<number>((resolve) => {
          const el = t.mediaType === 'video' ? document.createElement('video') : new Audio()
          el.preload = 'metadata'
          const done = (v: number) => {
            resolve(v)
          }
          const timer = setTimeout(() => done(0), 5000)
          el.onloadedmetadata = () => {
            clearTimeout(timer)
            const dur = el.duration
            done(Number.isFinite(dur) && dur > 0 ? dur : 0)
          }
          el.onerror = () => {
            clearTimeout(timer)
            done(0)
          }
          el.src = url
        })
        if (d > 0) {
          trackDurationRef.current = d
          setDuration(d)
          publishPosition(d, 0, 1)
          ensureAnchor(d)
        }
        if (t.mediaType === 'video') {
          // Stage (don't load): first Play reuses the blob without re-deriving
          // and finds the video already framed — but still runs the full swap.
          // The URL stays alive exactly like a loadTrack-derived one (revoked
          // on the next loadTrack, after its element is destroyed first).
          blobUrlRef.current = url
          setActiveTrackUrl(url)
          prevFileNameRef.current = t.fileName
          attachVideo(url)
        } else {
          // Phase B: the derived URL is cache-owned now — revoking it here
          // would poison the cache entry (dead blob on a later hit). Leave it;
          // LRU eviction revokes when it ages out.
        }
        addLog(`boot probe: track 1/${queue.length} staged (element untouched)`)
      })()
    }
  }, [queue.length])
  useEffect(() => { if (mediaRef.current) mediaRef.current.volume = isMuted ? 0 : volume }, [volume, isMuted])
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  return { play, pause, remotePauseOrResume, togglePlay, seek, seekRelative: (d:number)=>seek(frozenPosRef.current+d), nextTrack, prevTrack, goToTrack, reorderQueue, markNextGesture, videoContainerRef }
}
