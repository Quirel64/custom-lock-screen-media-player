import { useRef, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getFileURLFromOPFS } from '../lib/opfs'
import { showError } from '../components/ui/Toast'
import { addLog } from '../lib/logger'
import { createSilentWavUrl, describeSilentWav } from '../lib/silentAudio'
import { getPlayingArtwork } from '../lib/artwork'
import { VideoSyncController } from '../lib/videoSync'

/*
  FINAL — Same-element source swap (Arena idea + your 0.0000001 tweak).

  Why this wins over old anchor handoff / single-element freeze:
  - PWA iOS grants background permission per HTMLMediaElement. Cross-element play() (track <-> anchor)
    is often rejected as AbortError in standalone. Same permanent <audio> swapping src track <-> silent placeholder
    keeps the activation because play() happens synchronously in the MediaSession callback before any await.
  - Silent placeholder is duration-matched (no 2s loop snap) and HOLD_RATE 0.0000001 (your test: 0.25 still drifted, 1e-7 = 4 months per second)
  - Memory: 1 placeholder at a time (~2MB for 125s), revoked when not active, not OPFS — 5h track 28125KB still only 0.5s swap, no storage bloat

  States on one element: idle -> track (playing) -> anchor (paused, silent keeps session) -> track (resume)
  Logs: track resumed @ X / track → placeholder @ X / anchor source active @ X
*/

const HOLD_RATE = 0.0000001
const FALLBACK_HOLD_RATE = 0.0625

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
function delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

type SourceKind = 'track' | 'anchor'

export function useAudioEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const videoContainerRef = useRef<HTMLDivElement | null>(null)

  const blobUrlRef = useRef<string | null>(null)
  const anchorUrlRef = useRef('')
  const anchorForDurationRef = useRef(0)
  const urlCacheRef = useRef<Map<string, string>>(new Map())

  const videoSyncRef = useRef<VideoSyncController | null>(null)
  const frozenPosRef = useRef(0)
  const trackDurationRef = useRef(0)
  const transitionRef = useRef(false)
  const transitionTokenRef = useRef(0)
  const queuedCommandRef = useRef<'play' | 'pause' | null>(null)
  const commandRunnerRef = useRef<((c: 'play' | 'pause') => void) | null>(null)
  const loadGenRef = useRef(0)
  const prevTrackIdRef = useRef<string | null>(null)
  const nextGestureRef = useRef(false)

  const sourceKindRef = useRef<SourceKind>('track')
  const ownerRef = useRef<'idle' | 'track' | 'anchor'>('idle')

  const { currentTrackIndex, queue, volume, isMuted, setPlaying, setCurrentTime, setDuration, setCurrentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

  const getSync = useCallback(() => {
    if (!videoSyncRef.current) {
      videoSyncRef.current = new VideoSyncController({
        getAudio: () => mediaRef.current,
        getVideo: () => videoRef.current,
        isActive: () => sourceKindRef.current === 'track' && ownerRef.current === 'track' && !!mediaRef.current && !mediaRef.current.paused && document.visibilityState === 'visible',
        log: (m) => addLog(m),
        onStats: (s) => { if (s.lastAction !== 'locked' && s.lastAction !== 'idle') addLog(`vsync ${s.lastAction} drift ${s.drift.toFixed(2)} rate ${s.rate.toFixed(3)}`) },
      })
    }
    return videoSyncRef.current
  }, [])
  const stopRaf = useCallback(() => { videoSyncRef.current?.stop() }, [])
  const startVideoFrames = useCallback(() => { getSync().start() }, [getSync])

  const attachVideo = useCallback((url: string) => {
    let v = videoRef.current
    if (!v) {
      v = document.createElement('video')
      v.muted = true; (v as unknown as { defaultMuted: boolean }).defaultMuted = true
      v.playsInline = true; v.setAttribute('webkit-playsinline','true'); v.setAttribute('x-webkit-airplay','deny'); v.preload='auto'; v.controls=false
      // Hint iOS not to treat as remote media session
      try { (v as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true } catch {}
      v.style.width='100%'; v.style.height='100%'; v.style.objectFit='contain'; v.style.background='#000'
      videoRef.current = v
    }
    const c = videoContainerRef.current
    if (c && v.parentNode !== c) { c.innerHTML=''; c.appendChild(v) }
    if (v.src !== url) { v.src = url; v.load() }
    // Keep paused until dual-play; rAF fallback was seek-only, dual-play will call v.play() muted
    v.pause()
  }, [])
  const detachVideo = useCallback(() => { const v=videoRef.current; if(!v) return; v.pause(); v.removeAttribute('src'); v.load() }, [])
  const cleanupVideo = useCallback(() => { if (videoRef.current) { const v=videoRef.current; v.pause(); v.removeAttribute('src'); v.load(); if(v.parentNode) v.parentNode.removeChild(v); videoRef.current=null } }, [])

  const setOwner = useCallback((o: 'idle' | 'track' | 'anchor') => { ownerRef.current = o }, [])

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

  const activateSource = useCallback(async (kind: SourceKind, url: string, position: number) => {
    const media = mediaRef.current
    if (!media || !url) throw new Error('media or source missing')
    const token = ++transitionTokenRef.current
    sourceKindRef.current = kind
    setOwner('idle')
    setAudioSessionType()
    const rate = kind === 'anchor' ? HOLD_RATE : 1
    const isVideoTrack = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
    const v = videoRef.current
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
    if (kind === 'track' && Math.abs((media.currentTime || 0) - position) > 0.15) try { media.currentTime = position } catch {}
    // Sync lock UI before await to keep PWA gesture
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = kind === 'track' ? 'playing' : 'paused'
    // Video hardSync handles its own seek, no direct v.currentTime here
    const playPromise = media.play()
    // Dual-play: muted video plays alongside audio (native 30fps). Keep muted so iOS keeps audio session.
    let videoPlay: Promise<void> | null = null
    if (isVideoTrack && v && kind === 'track') { v.muted = true; try { videoPlay = v.play() } catch { /* ignore */ } }
    else if (v && kind === 'anchor') { try { v.pause() } catch {} }
    await playPromise
    if (videoPlay) await videoPlay.catch(() => { addLog('video.play failed, nudge will handle') })
    if (token !== transitionTokenRef.current) return
    if (kind === 'anchor') setPosWhenReady()
    setOwner(kind)
    if (kind === 'track') {
      setPlaying(true); publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1)
      if (isVideoTrack && v && v.src) { getSync().hardSync('activate'); getSync().start() }
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
    } else {
      setPlaying(false); publishPosition(trackDurationRef.current || media.duration, frozenPosRef.current, HOLD_RATE)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
    }
    addLog(`${kind} source active on permanent element @ ${media.currentTime.toFixed(2)}s${isVideoTrack && kind==='track' ? (v && !v.paused ? ' +video playing' : ' +video seek') : ''}`)
  }, [setOwner, startVideoFrames, setPlaying])

  const play = useCallback(async () => {
    const state = usePlayerStore.getState()
    const track = state.queue[state.currentTrackIndex] ?? currentTrack
    const media = mediaRef.current
    if (!track || !media) { addLog(`play ignored — no track (queue ${state.queue.length} idx ${state.currentTrackIndex})`); return }
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
        if (Number.isFinite(resumePos) && Math.abs((media.currentTime || 0) - resumePos) > 0.15) try { media.currentTime = resumePos } catch {}
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
        const directPlay = media.play()
        let vPlay: Promise<void> | null = null
        if (isVideoResume && vResume) { vResume.muted = true; try { vPlay = vResume.play() } catch {} }
        await directPlay
        if (vPlay) await vPlay.catch(() => addLog('video resume failed'))
        if (isVideoResume && vResume && vResume.src) { getSync().hardSync('resume'); getSync().start() }
        setOwner('track'); setPlaying(true)
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
        publishPosition(media.duration, media.currentTime, 1)
        addLog(`track resumed on permanent element @ ${media.currentTime.toFixed(2)}s${isVideoResume && vResume && !vResume.paused ? ' +video' : ''}`)
      } else {
        // Need src swap — ensure blob URL for OPFS track
        let url = blobUrlRef.current
        // If blob was revoked or track changed, re-derive
        if (!url || prevTrackIdRef.current !== track.id) {
          if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
          const fresh = await getFileURLFromOPFS(track.fileName)
          if (!fresh) { showError(`File not found: ${track.fileName}`); throw new Error('no url') }
          blobUrlRef.current = fresh; url = fresh
        }
        try { await activateSource('track', url, resumePos) } catch (e) {
          addLog(`track source swap play() failed: ${e}`); await delay(120); await activateSource('track', url, resumePos)
        }
      }
    } catch (e) { setPlaying(false); setOwner('idle'); addLog(`resume failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, currentTrack, flushQueued, setOwner, setPlaying, startVideoFrames])

  const pause = useCallback(async () => {
    const media = mediaRef.current
    if (!media) return
    if (sourceKindRef.current === 'anchor') { addLog('pause while placeholder → resume'); void play(); return }
    if (transitionRef.current) { queuedCommandRef.current = 'pause'; addLog('pause queued'); return }
    transitionRef.current = true
    try {
      const pos = media.currentTime
      frozenPosRef.current = pos; setCurrentTime(pos); setPlaying(false); stopRaf()
      const vPause = videoRef.current; if (vPause) try { vPause.pause() } catch {}
      ensureAnchor(trackDurationRef.current || media.duration || 2)
      await activateSource('anchor', anchorUrlRef.current, pos)
      addLog(`track → placeholder swap @ ${pos.toFixed(2)}s`)
    } catch (e) { setOwner('idle'); addLog(`placeholder swap failed: ${e}`) }
    finally { transitionRef.current = false; flushQueued() }
  }, [activateSource, ensureAnchor, flushQueued, play, setOwner, setPlaying, setCurrentTime, stopRaf])

  commandRunnerRef.current = (c) => { if (c === 'play') void play(); else void pause() }
  const togglePlay = useCallback(() => { if (ownerRef.current === 'track') void pause(); else void play() }, [pause, play])
  const remotePauseOrResume = useCallback(() => {
    // While placeholder is playing iOS still shows ||, so pause means resume
    if (sourceKindRef.current === 'anchor' || ownerRef.current === 'anchor') void play(); else void pause()
  }, [play, pause])

  const seek = useCallback((time: number) => {
    const media = mediaRef.current; if (!media) return
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

  const goToTrack = useCallback((i: number) => { nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(i) }, [setCurrentTrackIndex, setPlaying])

  const handleTrackEnd = useCallback(() => {
    const { getNextTrackIndex, repeatMode } = usePlayerStore.getState()
    addLog(`ended repeat=${repeatMode}`)
    if (repeatMode === 'one') { const m=mediaRef.current; if(m){ m.currentTime=0; frozenPosRef.current=0; setCurrentTime(0); setAudioSessionType(); m.play().catch(e=>addLog(`repeat-one failed: ${e}`)) } return }
    const n = getNextTrackIndex()
    if (n !== null) { addLog(`auto-next ${n}`); nextGestureRef.current = true; setPlaying(true); setCurrentTrackIndex(n) }
    else { setPlaying(false); // freeze at end to keep session
      const m=mediaRef.current; if(m){ frozenPosRef.current=m.currentTime; setPlaying(false); if('mediaSession'in navigator) navigator.mediaSession.playbackState='paused'; addLog('end -> frozen keep-alive') } }
  }, [setCurrentTrackIndex, setPlaying, setCurrentTime])

  const loadTrack = useCallback(async (idx: number) => {
    const { queue: qq } = usePlayerStore.getState()
    const t0 = qq[idx]; if (t0 && prevTrackIdRef.current && prevTrackIdRef.current !== t0.id) frozenPosRef.current = 0
    const gen = ++loadGenRef.current
    const { queue: q } = usePlayerStore.getState()
    const track = q[idx]; if (!track) return
    const prevId = prevTrackIdRef.current
    if (prevId && prevId !== track.id) addLog(`track change ${prevId.slice(0,4)} -> ${track.id.slice(0,4)}: will reset pos to 0`)

    // If frozen placeholder active, we'll swap to track — no need to keep HOLD_RATE
    transitionRef.current = false; queuedCommandRef.current = null

    stopRaf(); cleanupVideo()
    // Don't revoke cached URL here — cache keeps it for gesture-kept next/prev
    blobUrlRef.current = null

    // Try cache first to keep gesture for next/prev — OPFS is async and loses PWA gesture
    let url = urlCacheRef.current.get(track.fileName) ?? null
    if (!url) {
      url = await getFileURLFromOPFS(track.fileName)
      if (url) urlCacheRef.current.set(track.fileName, url)
    }
    if (gen !== loadGenRef.current) { addLog(`load [${idx+1}] stale gen ${gen} abandoned`); // don't revoke cached url
      return }
    if (!url) { showError(`File not found: ${track.fileName}`); return }
    blobUrlRef.current = url
    const el = mediaRef.current; if (!el) return
    setCurrentTime(0); setDuration(0); trackDurationRef.current = 0
    prevTrackIdRef.current = track.id

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
    addLog(`load [${idx+1}/${q.length}] ${track.name} autoplay=${shouldAutoplay} (wasPlaying=${wasPlaying})`)
    if (shouldAutoplay) {
      void play()
    } else {
      el.src = url; el.load()
    }
  }, [attachVideo, cleanupVideo, setCurrentTime, setDuration, stopRaf])

  // Permanent element once
  useEffect(() => {
    const media = document.createElement('audio')
    media.preload = 'auto'; media.controls = true; media.setAttribute('playsinline','true'); media.setAttribute('webkit-playsinline','true'); media.setAttribute('x-webkit-airplay','allow'); (media as unknown as { dataset: Record<string,string> }).dataset.sessionOwner='permanent'
    hideOffscreen(media); document.body.appendChild(media); mediaRef.current = media
    const nav = navigator as Navigator & { standalone?: boolean }
    const standalone = (nav as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches
    addLog(`environment: ${standalone ? 'home-screen standalone PWA' : 'browser tab'}; permanent element ready`)

    const onLoadedMetadata = () => {
      if (sourceKindRef.current === 'anchor') return
      const d = media.duration; if (!Number.isFinite(d) || d<=0) return
      trackDurationRef.current = d; setDuration(d); publishPosition(d, media.currentTime, 1)
      ensureAnchor(d)
    }
    const onPlaying = () => {
      const k = sourceKindRef.current
      if (k==='track') { setOwner(k); setPlaying(true); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing' }
      else { setOwner(k); setPlaying(false); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused' }
      addLog(`native playing (${k}, same element)`)
    }
    const onPause = () => { if (transitionRef.current) return; if (sourceKindRef.current==='track' && ownerRef.current==='track') setPlaying(false); addLog(`native pause (${sourceKindRef.current})`) }
    const onTimeUpdate = () => {
      if (sourceKindRef.current==='track') { if (!transitionRef.current) frozenPosRef.current = media.currentTime; setCurrentTime(media.currentTime); publishPosition(media.duration, media.currentTime, 1); return }
      // Best effort: frozen track pos is authoritative even if anchor bar drifts — threshold 0.35 avoids PC constant rewind loop
      const frozen = frozenPosRef.current
      if (media.currentTime - frozen >= 0.35) { try { media.currentTime = Math.min(frozen, Math.max(0, media.duration - 0.35)) } catch {} }
      publishPosition(trackDurationRef.current || media.duration, frozen, media.playbackRate || HOLD_RATE)
    }
    const onEnded = () => {
      if (sourceKindRef.current==='anchor') { const safe=Math.max(0, Math.min(frozenPosRef.current, media.duration-0.35)); media.currentTime=safe; media.play().catch(e=>addLog(`placeholder restart failed: ${e}`)); return }
      handleTrackEnd()
    }
    const onError = () => addLog(`permanent media error: code ${media.error?.code} ${media.error?.message||''}`)
    media.addEventListener('loadedmetadata', onLoadedMetadata); media.addEventListener('durationchange', onLoadedMetadata)
    media.addEventListener('playing', onPlaying); media.addEventListener('pause', onPause)
    media.addEventListener('timeupdate', onTimeUpdate); media.addEventListener('ended', onEnded); media.addEventListener('error', onError)
    setAudioSessionType(); addLog('permanent audio element ready (same-element handoff)')
    return () => {
      stopRaf(); transitionTokenRef.current+=1; media.pause(); media.removeAttribute('src'); media.load(); media.remove(); mediaRef.current=null
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current); if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [ensureAnchor, handleTrackEnd, setDuration, setPlaying, setCurrentTime, startVideoFrames, stopRaf])

  useEffect(() => { const t=queue[currentTrackIndex]; if(!t) return; if (t.mediaType==='video') attachVideo(blobUrlRef.current||''); else detachVideo() }, [currentTrackIndex, queue])

  useEffect(() => {
    const onVis = () => {
      addLog(`visibility -> ${document.visibilityState}`)
      if (document.visibilityState==='hidden') { stopRaf(); videoRef.current?.pause(); return }
      setAudioSessionType()
      const m=mediaRef.current; const v=videoRef.current
      const isVideo = usePlayerStore.getState().queue[usePlayerStore.getState().currentTrackIndex]?.mediaType === 'video'
      if (ownerRef.current==='track' && m && !m.paused) {
        if (isVideo && v && v.src && v.paused) { v.muted = true; v.play().catch(() => addLog('visible video fallback disabled')) }
        else if (!isVideo) startVideoFrames()
      }
    }
    const onPageShow = (e: PageTransitionEvent) => { setAudioSessionType(); addLog(`pageshow${(e as unknown as { persisted?: boolean }).persisted?' (bfcache)':''}`) }
    document.addEventListener('visibilitychange', onVis); window.addEventListener('pageshow', onPageShow as EventListener)
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pageshow', onPageShow as EventListener) }
  }, [startVideoFrames, stopRaf])

  useEffect(() => { if (currentTrack && queue.length>0) void loadTrack(currentTrackIndex) }, [currentTrackIndex, currentTrack?.id])
  useEffect(() => { if (mediaRef.current) mediaRef.current.volume = isMuted ? 0 : volume }, [volume, isMuted])
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  return { play, pause, remotePauseOrResume, togglePlay, seek, seekRelative: (d:number)=>seek(frozenPosRef.current+d), nextTrack, prevTrack, goToTrack, videoContainerRef }
}
