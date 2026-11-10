import { motion } from 'framer-motion'
import { usePlayerStore } from '../../stores/playerStore'
import { formatTime } from '../../lib/format'
import type { Track } from '../../lib/types'

const APP_VERSION = '1.1.0'

interface NowPlayingProps {
  currentTrack: Track | null
  videoContainerRef: React.RefObject<HTMLDivElement | null>
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function NowPlaying({ currentTrack, videoContainerRef, collapsed, onToggleCollapsed }: NowPlayingProps) {
  const { currentTime, duration } = usePlayerStore()

  const CollapseBtn = onToggleCollapsed ? (
    <button onClick={onToggleCollapsed} className="rounded-full bg-slate-800 p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white" title={collapsed ? 'Expand player' : 'Collapse player'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{collapsed ? <path d="M6 9l6 6 6-6" /> : <path d="M6 15l6-6 6 6" />}</svg>
    </button>
  ) : null

  if (!currentTrack) {
    return (
      <div className="flex h-full flex-col">
        {/* Keep video container mounted even with no track so ref never swaps */}
        <div key="video-container" ref={videoContainerRef} className="hidden" />
        <div className="flex h-full items-center justify-center p-4">
          <div className="flex w-full items-center justify-between">
            <div className="text-center text-slate-600 flex-1">
              <div className="mb-1 text-2xl">🎶</div>
              <p className="text-xs">Select a track to play</p>
            </div>
            {CollapseBtn}
          </div>
        </div>
      </div>
    )
  }

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {/* Keep same key so React reuses the node and <video> stays mounted */}
        <div key="video-container" ref={videoContainerRef} className="hidden" />
        <div className="flex items-center gap-3 px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{currentTrack.name}</p>
            <p className="truncate text-xs text-slate-500">{currentTrack.artist} • {formatTime(currentTime)} / {formatTime(duration)}</p>
          </div>
          {CollapseBtn}
        </div>
      </div>
    )
  }

  if (currentTrack.mediaType === 'video') {
    return (
      <div className="flex flex-col gap-4 p-4" style={{ paddingTop: 'calc(1rem + env(safe-area-inset-top, 0px))' }}>
        <div className="flex justify-end">{CollapseBtn}</div>
        <div
          key="video-container"
          ref={videoContainerRef}
          className="relative flex w-full items-center justify-center overflow-hidden rounded-xl bg-black"
          style={{ aspectRatio: '16/9', maxHeight: '40vh' }}
        >
          {/* Video element gets appended here by useAudioEngine */}
        </div>
        <div className="px-2">
          <motion.h2
            key={currentTrack.name}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-1 text-lg font-bold text-white"
          >
            {currentTrack.name}
          </motion.h2>
          <p className="text-sm text-slate-400">
            {currentTrack.artist}
            {currentTrack.album !== 'Unknown Album' && ` • ${currentTrack.album}`}
          </p>
          <p className="mt-1 text-[10px] text-slate-700">v{APP_VERSION}</p>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      key={currentTrack.id}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-center gap-6 p-8 relative"
    >
      <div key="video-container" ref={videoContainerRef} className="hidden" />
      <div className="absolute right-4 top-4">{CollapseBtn}</div>
      <motion.div
        className="flex h-48 w-48 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/30 to-accent/30 shadow-2xl"
        animate={{ rotate: currentTime > 0 ? [0, 0, 0] : 0 }}
        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
      >
        <span className="text-6xl">🎵</span>
      </motion.div>

      <div className="text-center">
        <motion.h2
          key={currentTrack.name}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-1 text-xl font-bold text-white"
        >
          {currentTrack.name}
        </motion.h2>
        <p className="text-sm text-slate-400">
          {currentTrack.artist}
          {currentTrack.album !== 'Unknown Album' && ` • ${currentTrack.album}`}
        </p>
        <p className="mt-2 text-[10px] text-slate-700">v{APP_VERSION}</p>
      </div>

      <div className="w-full max-w-md">
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-slate-700">
          <motion.div
            className="absolute left-0 top-0 h-full bg-primary"
            style={{ width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' }}
            transition={{ duration: 0.1 }}
          />
        </div>
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </motion.div>
  )
}
