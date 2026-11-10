import { useEffect, useRef, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import type { Track, LockScreenMode } from '../lib/types'
import { getPlayingArtwork } from '../lib/artwork'
import { addLog } from '../lib/logger'
import { isLockResilientToggle, isMinimalHandlers, getLockReviveDelay } from '../lib/mediaFlags'

/*
  Lock screen bridge — single-element freeze (no anchor).
  - Shows title/artist/artwork — single artwork now (no playing/paused toggle, anchor-era visual hack removed)
  - Registers either skip10 (±10s) or prevnext (<< >>) buttons via lockScreenMode toggle, never both (iOS bug)
  - Central pause button routes through remotePauseOrResume because while frozen we keep audio playing at 0.001 vol — lock still shows ▶️ and pause means resume
*/

export function useMediaSession() {
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  const remotePauseOrResumeRef = useRef<((press?: 'play' | 'pause') => void) | null>(null)
  const seekRef = useRef<((t: number) => void) | null>(null)
  const prevRef = useRef<(() => void) | null>(null)
  const nextRef = useRef<(() => void) | null>(null)

  const { currentTrackIndex, queue, lockScreenMode } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]
  // Unmount marker: declared BEFORE the registration effect so its cleanup
  // runs first at unmount (registration cleanup then knows it's final).
  const unmountedRef = useRef(false)
  const lastAppliedModeRef = useRef<LockScreenMode | null>(null)

  // Artwork sync — single artwork (anchor toggle removed)
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentTrack) return
    const art = getPlayingArtwork()
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.name,
      artist: currentTrack.artist || 'Unknown Artist',
      album: currentTrack.album || 'Unknown Album',
      artwork: [{ src: art, sizes: '300x300', type: 'image/svg+xml' }],
    })
  }, [currentTrack, currentTrack?.id])

  // Button handlers — re-register when mode toggles.
  // Both center buttons route through remote toggle when available (resilient to inverted icon on iOS 26.2 lock screen).
  // Extracted so App can re-apply on play start: boot-time registrations happen
  // while no session exists, and iOS can ignore null-ing then — re-applying in
  // an ACTIVE session forces exactly one correct set.
  const applyHandlers = useCallback((mode: LockScreenMode, track: Track | undefined) => {
    if (!('mediaSession' in navigator)) return
    const safe = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* ignore */ }
    }

    const handlePlay = () => {
      addLog('MediaSession play (center ▶️)')
      // Resilient mode (default): engine-aware toggle (checks anchor vs track) so an
      // inverted icon still resumes correctly. Experiment OFF: literal play.
      // Press kind passed through: echo-aware only gates "pause" presses (the
      // interruption echo shape) — a play press is always a genuine resume.
      if (isLockResilientToggle() && remotePauseOrResumeRef.current) remotePauseOrResumeRef.current('play')
      else playRef.current?.()
    }
    const handlePause = () => {
      addLog('MediaSession pause (center ||)')
      if (isLockResilientToggle() && remotePauseOrResumeRef.current) remotePauseOrResumeRef.current('pause')
      else pauseRef.current?.()
    }
    safe('play', handlePlay)
    safe('pause', handlePause)
    safe('seekto', (d) => { if (d.seekTime != null) seekRef.current?.(d.seekTime) })

    if (mode === 'skip10') {
      safe('seekbackward', (d) => {
        const { currentTime } = usePlayerStore.getState()
        seekRef.current?.(Math.max(0, currentTime - (d.seekOffset ?? 10)))
      })
      safe('seekforward', (d) => {
        const { currentTime, duration } = usePlayerStore.getState()
        seekRef.current?.(Math.min(duration, currentTime + (d.seekOffset ?? 10)))
      })
      safe('previoustrack', null)
      safe('nexttrack', null)
    } else {
      safe('previoustrack', () => prevRef.current?.())
      safe('nexttrack', () => nextRef.current?.())
      safe('seekbackward', null)
      safe('seekforward', null)
    }
    addLog(`lockscreen handlers applied: ${mode}`)
    // iOS builds the lock UI from handlers + metadata together: a boot-time
    // mode restore (skip10 → prevnext before first play) otherwise leaves the
    // stale skip10 UI up until the user toggles twice. Re-push metadata so the
    // fresh handler set takes effect immediately.
    if (track) {
      const art = getPlayingArtwork()
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name,
          artist: track.artist || 'Unknown Artist',
          album: track.album || 'Unknown Album',
          artwork: [{ src: art, sizes: '300x300', type: 'image/svg+xml' }],
        })
      } catch { /* ignore */ }
    }
  }, [])

  useEffect(() => {
    const mounted = unmountedRef
    return () => { mounted.current = false }
  }, [])

  // Registration: applies on mount, on mode change, and (unless the Minimal
  // applies experiment says otherwise) on every track change.
  useEffect(() => {
    // Minimal applies: under the proven snapshot model, the same-set re-apply
    // on each track change only feeds iOS another identical snapshot — skip
    // it (metadata is updated by the separate effect above). Boot apply and
    // mode toggles still apply; the hidden mode-flip revive still delivers a
    // fresh set at lock time.
    const minimal = isMinimalHandlers()
    const modeChanged = lastAppliedModeRef.current !== lockScreenMode
    lastAppliedModeRef.current = lockScreenMode
    if (minimal && !modeChanged) {
      addLog('lockscreen handlers: minimal applies — skip identical re-apply')
    } else {
      applyHandlers(lockScreenMode, currentTrack)
    }
    return () => {
      // Minimal applies: on a mere dependency change (component still mounted),
      // keep the previous handler set registered instead of nulling it — the
      // next apply (mode toggle or hidden flip) will rewrite it anyway. On
      // real unmount the marker effect above has already cleared
      // unmountedRef, so the null-out runs as before.
      if (unmountedRef.current && isMinimalHandlers()) return
      if (!('mediaSession' in navigator)) return
      const safe = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
        try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* ignore */ }
      }
      safe('play', null); safe('pause', null); safe('seekto', null)
      safe('seekbackward', null); safe('seekforward', null)
      safe('previoustrack', null); safe('nexttrack', null)
    }
  }, [applyHandlers, lockScreenMode, currentTrack?.id])

  const setHandlers = (h: {
    onPlay: () => void
    onPause: () => void
    onRemotePauseOrResume: (press?: 'play' | 'pause') => void
    onPrev: () => void
    onNext: () => void
    onSeek: (t: number) => void
  }) => {
    playRef.current = h.onPlay
    pauseRef.current = h.onPause
    remotePauseOrResumeRef.current = h.onRemotePauseOrResume
    prevRef.current = h.onPrev
    nextRef.current = h.onNext
    seekRef.current = h.onSeek
  }

  // Re-apply the CURRENT store mode (for App's play-start edge).
  const reapplyHandlers = useCallback(() => {
    const st = usePlayerStore.getState()
    applyHandlers(st.lockScreenMode, st.queue[st.currentTrackIndex] ?? undefined)
  }, [applyHandlers])

  // Revive v2 (mode flip): re-applying the SAME set does not un-grey a wedged
  // lock UI (logs show the same re-applies present in working AND greyed
  // runs), but changing the button configuration empirically does (in-app
  // skip10→prevnext→skip10 revived greyed controls). Do exactly that as the
  // session goes hidden: flip, wait 300ms, restore. The lock UI is glimpsed
  // mid-flip at worst; lockScreenMode in the store is never touched.
  const reviveHandlers = useCallback(() => {
    const st = usePlayerStore.getState()
    const current = st.lockScreenMode
    const track = st.queue[st.currentTrackIndex] ?? undefined
    const toggled = current === 'skip10' ? 'prevnext' : 'skip10'
    applyHandlers(toggled, track)
    addLog(`lock revive: mode flip ${current} → ${toggled} → restoring…`)
    window.setTimeout(() => applyHandlers(current, track), getLockReviveDelay())
  }, [applyHandlers])

  return { setHandlers, reapplyHandlers, reviveHandlers }
}
