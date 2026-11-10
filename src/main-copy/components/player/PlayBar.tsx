import { useRef, useCallback } from 'react'
import { usePlayerStore } from '../../stores/playerStore'
import { formatTime } from '../../lib/format'
import type { Track } from '../../lib/types'

interface PlayBarProps {
  currentTrack: Track | null
  onTogglePlay: () => void
  onNext: () => void
  onPrev: () => void
  onSeek: (time: number) => void
}

export function PlayBar({ currentTrack, onTogglePlay, onNext, onPrev, onSeek }: PlayBarProps) {
  const { isPlaying, currentTime, duration, volume, isMuted, shuffleOn, repeatMode, queue, lockScreenMode, setVolume, toggleMute, toggleShuffle, cycleRepeat, toggleLockScreenMode } =
    usePlayerStore()

  const seekBarRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  const getSeekTime = useCallback((clientX: number) => {
    const bar = seekBarRef.current
    if (!bar || duration <= 0) return 0
    const rect = bar.getBoundingClientRect()
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    return (x / rect.width) * duration
  }, [duration])

  const handleSeekStart = useCallback((clientX: number) => {
    isDragging.current = true
    onSeek(getSeekTime(clientX))
  }, [onSeek, getSeekTime])

  const handleSeekMove = useCallback((clientX: number) => {
    if (!isDragging.current) return
    onSeek(getSeekTime(clientX))
  }, [onSeek, getSeekTime])

  const handleSeekEnd = useCallback(() => {
    isDragging.current = false
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    handleSeekStart(e.clientX)

    const onMouseMove = (ev: MouseEvent) => handleSeekMove(ev.clientX)
    const onMouseUp = () => {
      handleSeekEnd()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [handleSeekStart, handleSeekMove, handleSeekEnd])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    handleSeekStart(e.touches[0].clientX)
  }, [handleSeekStart])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    handleSeekMove(e.touches[0].clientX)
  }, [handleSeekMove])

  const handleTouchEnd = useCallback(() => {
    handleSeekEnd()
  }, [handleSeekEnd])

  const handleBarClick = useCallback((e: React.MouseEvent) => {
    onSeek(getSeekTime(e.clientX))
  }, [onSeek, getSeekTime])

  const hasMultipleTracks = queue.length > 1

  const shuffleColor = shuffleOn ? '#6366f1' : '#64748b'
  const repeatColor = repeatMode !== 'off' ? '#6366f1' : '#64748b'

  return (
    <div className="flex items-center gap-4 px-4 py-3 md:px-6">
      {/* Track info */}
      <div className="hidden min-w-0 flex-1 md:block">
        {currentTrack ? (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/30 to-accent/30">
              <span className="text-lg">🎵</span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-white">{currentTrack.name}</p>
              <p className="truncate text-xs text-slate-400">{currentTrack.artist}</p>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-500">No track selected</div>
        )}
      </div>

      {/* Center controls */}
      <div className="flex flex-1 flex-col items-center gap-1 md:flex-none md:w-96">
        <div className="flex items-center gap-3">
          {hasMultipleTracks && (
            <button
              onClick={toggleShuffle}
              className="p-2 transition-colors hover:opacity-80"
              style={{ color: shuffleColor, touchAction: 'manipulation' }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 3 21 3 21 8" />
                <line x1="4" y1="20" x2="21" y2="3" />
                <polyline points="21 16 21 21 16 21" />
                <line x1="15" y1="15" x2="21" y2="21" />
                <line x1="4" y1="4" x2="9" y2="9" />
              </svg>
            </button>
          )}

          <button
            onClick={onPrev}
            className="p-2 transition-colors hover:opacity-80"
            style={{ color: '#94a3b8' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>

          <button
            onClick={onTogglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white active:scale-95"
            style={{ color: '#0a0e1a' }}
          >
            {isPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            onClick={onNext}
            className="p-2 transition-colors hover:opacity-80"
            style={{ color: '#94a3b8' }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>

          {hasMultipleTracks && (
            <button
              onClick={cycleRepeat}
              className="p-2 transition-colors hover:opacity-80"
              style={{ color: repeatColor, touchAction: 'manipulation' }}
            >
              {repeatMode === 'one' ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  <text x="12" y="14" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8" fontWeight="bold">1</text>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9" />
                  <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                  <polyline points="7 23 3 19 7 15" />
                  <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                </svg>
              )}
            </button>
          )}
          {/* Lock screen mode toggle: skip10 (±10s) vs prevnext (<< >>) */}
          <button
            onClick={toggleLockScreenMode}
            className="ml-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors"
            style={{
              borderColor: lockScreenMode === 'skip10' ? '#6366f1' : '#334155',
              color: lockScreenMode === 'skip10' ? '#818cf8' : '#94a3b8',
              background: lockScreenMode === 'skip10' ? 'rgba(99,102,241,0.12)' : 'transparent',
              touchAction: 'manipulation',
            }}
            title={lockScreenMode === 'skip10' ? 'Lock screen: ±10s skip (tap to switch to Prev/Next)' : 'Lock screen: Prev/Next track (tap to switch to ±10s)'}
          >
            {lockScreenMode === 'skip10' ? '±10s' : '◀▶'}
          </button>
        </div>

        {/* Seek bar */}
        <div className="flex w-full items-center gap-2">
          <span className="w-10 text-right text-xs text-slate-500">{formatTime(currentTime)}</span>
          <div
            ref={seekBarRef}
            onClick={handleBarClick}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="group relative h-1.5 flex-1 cursor-pointer rounded-full bg-slate-700 touch-none"
          >
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-primary"
              style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }}
            />
            <div
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-md transition-opacity group-hover:opacity-100"
              style={{
                left: duration > 0 ? `calc(${(currentTime / duration) * 100}% - 6px)` : '0',
                opacity: isDragging.current ? 1 : undefined,
              }}
            />
          </div>
          <span className="w-10 text-xs text-slate-500">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="hidden items-center gap-2 md:flex">
        <button onClick={toggleMute} className="p-2 text-slate-400 transition-colors hover:text-white">
          {isMuted || volume === 0 ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            </svg>
          ) : volume < 0.5 ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            </svg>
          )}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={isMuted ? 0 : volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-20 accent-primary"
        />
      </div>
    </div>
  )
}
