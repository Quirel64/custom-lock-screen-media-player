import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Track } from '../../lib/types'

interface TrackListProps {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
  hideHeader?: boolean
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TrackList({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, hideHeader }: TrackListProps) {
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelect = (trackId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }

  const selectAll = () => {
    setSelectedIds(new Set(tracks.map((t) => t.id)))
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  const deleteSelected = () => {
    const selected = tracks.filter((t) => selectedIds.has(t.id))
    if (selected.length > 0 && onRemoveTracks) {
      onRemoveTracks(selected)
    }
    setSelectedIds(new Set())
    setSelectMode(false)
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  if (tracks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-center"
        >
          <div className="mb-4 text-6xl">🎵</div>
          <h2 className="mb-2 text-xl font-semibold text-white">No Music Yet</h2>
          <p className="mb-6 text-sm text-slate-400">
            Open a folder or select audio files to get started
          </p>
          <div className="flex gap-3">
            <button
              onClick={onPickFolder}
              className="rounded-lg bg-primary px-4 py-2.5 font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
            >
              Open Folder
            </button>
            <button
              onClick={onPickFiles}
              className="rounded-lg border border-slate-700 px-4 py-2.5 font-medium text-slate-300 transition-colors hover:border-accent hover:text-accent"
            >
              Select Files
            </button>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {!hideHeader && (
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">Library</h2>
            <p className="text-sm text-slate-400">
              {selectMode
                ? `${selectedIds.size} of ${tracks.length} selected`
                : `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          <div className="flex gap-2">
            {selectMode ? (
              <>
                <button
                  onClick={selectedIds.size === tracks.length ? deselectAll : selectAll}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  {selectedIds.size === tracks.length ? 'Deselect All' : 'Select All'}
                </button>
                <button
                  onClick={exitSelectMode}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setSelectMode(true)}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  Select
                </button>
                <button
                  onClick={onPickFolder}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  + Folder
                </button>
                <button
                  onClick={onPickFiles}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:bg-slate-700"
                >
                  + Files
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <AnimatePresence mode="popLayout">
          {tracks.map((track, index) => {
            const isSelected = selectedIds.has(track.id)
            return (
              <motion.div
                key={track.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2, delay: index * 0.02 }}
                onClick={() => {
                  if (selectMode) {
                    toggleSelect(track.id)
                  } else {
                    onSelectTrack(index)
                  }
                }}
                className={`group flex cursor-pointer items-center gap-4 rounded-lg px-4 py-3 transition-colors ${
                  selectMode && isSelected
                    ? 'bg-primary/20'
                    : index === currentTrackIndex
                    ? 'bg-primary/20 text-primary-light'
                    : 'text-slate-300 hover:bg-slate-800/50'
                }`}
              >
                <div className="flex w-8 items-center justify-center">
                  {selectMode ? (
                    <div
                      className={`h-5 w-5 rounded border-2 transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary'
                          : 'border-slate-600'
                      }`}
                    >
                      {isSelected && (
                        <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor">
                          <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                        </svg>
                      )}
                    </div>
                  ) : index === currentTrackIndex ? (
                    <motion.div
                      animate={{ scale: [1, 1.2, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                      className="h-4 w-4 rounded-full bg-primary"
                    />
                  ) : (
                    <span className="text-sm text-slate-500">{index + 1}</span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium">{track.name}</p>
                    {track.mediaType === 'video' && (
                      <span className="flex-shrink-0 text-xs text-slate-500">🎬</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-slate-500">
                    {track.artist} {track.album !== 'Unknown Album' ? `• ${track.album}` : ''}
                  </p>
                </div>

                <span className="text-xs text-slate-600">{formatSize(track.size)}</span>
                <span className="w-12 text-right text-xs text-slate-500">
                  {formatDuration(track.duration)}
                </span>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* Selection action bar */}
      <AnimatePresence>
        {selectMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: 60 }}
            animate={{ y: 0 }}
            exit={{ y: 60 }}
            className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3"
          >
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={deleteSelected}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
              >
                Delete ({selectedIds.size})
              </button>
              <button
                onClick={exitSelectMode}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
