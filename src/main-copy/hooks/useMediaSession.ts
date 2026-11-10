import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { getPlayingArtwork } from '../lib/artwork'
import { addLog } from '../lib/logger'

/*
  Lock screen bridge — single-element freeze (no anchor).
  - Shows title/artist/artwork — single artwork now (no playing/paused toggle, anchor-era visual hack removed)
  - Registers either skip10 (±10s) or prevnext (<< >>) buttons via lockScreenMode toggle, never both (iOS bug)
  - Central pause button routes through remotePauseOrResume because while frozen we keep audio playing at 0.001 vol — lock still shows ▶️ and pause means resume
*/

export function useMediaSession() {
  const playRef = useRef<(() => void) | null>(null)
  const pauseRef = useRef<(() => void) | null>(null)
  const remotePauseOrResumeRef = useRef<(() => void) | null>(null)
  const seekRef = useRef<((t: number) => void) | null>(null)
  const prevRef = useRef<(() => void) | null>(null)
  const nextRef = useRef<(() => void) | null>(null)

  const { currentTrackIndex, queue, lockScreenMode } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex]

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

  // Button handlers — re-register when mode toggles
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const safe = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* ignore */ }
    }

    safe('play', () => { addLog('MediaSession play (center ▶️)'); playRef.current?.() })
    safe('pause', () => { addLog('MediaSession pause (center ||)'); pauseRef.current?.() })
    safe('seekto', (d) => { if (d.seekTime != null) seekRef.current?.(d.seekTime) })

    if (lockScreenMode === 'skip10') {
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

    return () => {
      safe('play', null); safe('pause', null); safe('seekto', null)
      safe('seekbackward', null); safe('seekforward', null)
      safe('previoustrack', null); safe('nexttrack', null)
    }
  }, [lockScreenMode])

  const setHandlers = (h: {
    onPlay: () => void
    onPause: () => void
    onRemotePauseOrResume: () => void
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

  return { setHandlers }
}
