import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import type { Track } from '../../lib/types'
import { PlayingIndicator } from '../ui/PlayingIndicator'
import { HoldRing } from '../ui/HoldRing'
import { useHoldToDrag, unblockTouchScroll } from '../ui/useHoldToDrag'
import { useScrollSlotSync } from '../ui/useScrollSlotSync'
import { orderByIds } from '../../lib/queue'
import { addLog } from '../../lib/logger'
// TEMP-TELEMETRY (scroll-drift diagnosis — remove with the onDrag hook below)
import { telemetryDragSample } from '../../lib/dragTelemetry'


interface TrackListProps {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
  hideHeader?: boolean
  externalSelectMode?: boolean
  onExternalSelectModeChange?: (v: boolean) => void
  selectAllTrigger?: number
  selectClearTrigger?: number
  // Reorder mode (#10): hold-and-drag (grip or row hold) with tap-to-play and
  // select intact. Parent owns persistence + live queue mapping via ONE
  // full-order commit at drop — never a from/to splice (those collapse
  // multi-step drags).
  reorderMode?: boolean
  onReorderCommit?: (newIds: string[]) => void
  // Row-level hold entry: flips visual Order mode, then the same gesture
  // starts dragging on the already-live controls (no remount, no transfer).
  // Undefined = holds do nothing here.
  onHoldToOrder?: () => void
  // Fires on every drop (changed or not) so hold-entered sessions can auto-exit.
  onDropEnd?: () => void
  // Hold-entered sessions (grips hidden) also exit when the finger lifts WITHOUT
  // any drop — otherwise a failed start strands an empty Order mode. The
  // check is deferred a tick so a real drop's commit (window-level pointerup
  // listener) lands first; unmounting before commit would eat the reorder.
  onReleaseWithoutDrop?: () => void
  // Grips are exclusive to button-entered Order mode (accessibility without
  // cluttering hold-entered drags, which need no handle).
  showGrips?: boolean
  // Controlled selection (S1): when provided, selection state lives in the
  // parent so Queue mode and Group detail share ONE set — no loose states.
  // Falls back to internal state when absent.
  externalSelectedIds?: Set<string>
  onSelectedIdsChange?: (ids: Set<string>) => void
  // When true the highlighted row is the library source of a playlist
  // occurrence playing elsewhere (muted dot, not the pulsing one).
  currentIsSource?: boolean
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

// Draggable row in the single always-mounted Reorder tree: grip-only dragging
// (dragListener={false}) so scroll works everywhere else; row holds start on
// the same live controls. select-none stops iOS text selection mid-drag.
function DragTrackRow({ track, index, isCurrent, currentIsSource, selectMode, isSelected, onToggleSelect, showGrip, holdToOrder, dropStampRef, onPlay, onCommitMove, onDragBegin }: {
  track: Track
  index: number
  isCurrent: boolean
  currentIsSource?: boolean
  selectMode: boolean
  isSelected: boolean
  onToggleSelect: () => void
  showGrip: boolean
  // Row-level hold: flips visual Order mode first when needed, then the same
  // gesture starts on these already-live controls (no remount mid-gesture).
  // Undefined = holds do nothing here.
  holdToOrder?: () => void
  // Stamp of the last drop commit: clicks inside it are the release itself.
  dropStampRef: React.RefObject<number>
  onPlay: () => void
  onCommitMove: () => void
  onDragBegin: (id: string) => void
}) {
  const controls = useDragControls()
  // Long-press anywhere on the row also grabs it (same controls as the grip).
  // touch-action flips to none only while held: the flip lands while the finger
  // is still stationary, so the first move belongs to the drag, not the scroller.
  const hold = useHoldToDrag({
    shouldStart: () => !selectMode && !!holdToOrder,
    onStarting: () => holdToOrder?.(),
    onFire: (e) => {
      try {
        controls.start(e)
        // TEMP-TELEMETRY (hold-drag diagnosis — remove once green)
        addLog('hold fire: drag live (library)')
      } catch {
        // TEMP-TELEMETRY (hold-drag diagnosis — remove once green)
        addLog('hold fire: start threw (library)')
      }
    },
  })
  const lifted = hold.dragging
  // Row element for telemetry: framer's onDrag event has no currentTarget
  // (native pointer event), so we measure via ref instead.
  const rowRef = useRef<HTMLLIElement | null>(null)
  return (
    <Reorder.Item
      ref={rowRef}
      value={track.id}
      data-drag-id={track.id}
      dragListener={false}
      dragControls={controls}
      whileDrag={{ scale: 1.04, boxShadow: '0 10px 28px rgba(0,0,0,0.5)' }}
      exit={{ opacity: 0 }}
      onDragStart={() => onDragBegin(track.id)}
      onDragEnd={() => onCommitMove()}
      onDrag={(_e, info) => {
        telemetryDragSample('lib', rowRef.current, info.point.y)
      }}
      onClick={() => {
        if (Date.now() - dropStampRef.current < 300) return
        if (selectMode) onToggleSelect()
        else onPlay()
      }}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      className={`group flex cursor-pointer select-none items-center gap-4 rounded-lg px-4 py-3 ${
        hold.dragging ? 'touch-none' : 'touch-pan-y'
      } ${
        // NOTE: no Tailwind scale/shadow here on purpose — whileDrag above
        // already scales the row via framer's transform. Adding a second
        // scale via CSS (scale-[1.04] uses the `scale` property, which
        // multiplies with framer's `transform`) made the held row ~8%
        // larger than measured, so it drifted ahead of the finger and flew
        // off-screen once edge autoscroll kicked in. Grip drags never set
        // hold.dragging, which is why only hold-drags drifted.
        lifted ? 'relative z-10' : ''
      } ${
        isCurrent ? 'bg-primary/20 text-primary-light' : 'text-slate-300 hover:bg-slate-800/50'
      }`}
    >
      <div className="flex w-8 items-center justify-center">
        {hold.holdArmed ? (
          <HoldRing />
        ) : selectMode ? (
          <div
            className={`h-5 w-5 rounded border-2 transition-colors ${
              isSelected ? 'border-primary bg-primary' : 'border-slate-600'
            }`}
          >
            {isSelected && (
              <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
              </svg>
            )}
          </div>
        ) : showGrip ? (
        <span
          onPointerDown={(e) => controls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab touch-none rounded px-1.5 py-2 text-sm leading-none text-slate-500 hover:bg-slate-700 hover:text-white active:cursor-grabbing"
          title="Hold and drag to reorder"
        >
          ⋮⋮
        </span>
        ) : isCurrent ? (
          <PlayingIndicator variant={currentIsSource ? 'source' : 'playing'} />
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
    </Reorder.Item>
  )
}

export function TrackList({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, onAddToPlaylist, hideHeader, externalSelectMode, onExternalSelectModeChange, selectAllTrigger, selectClearTrigger, reorderMode, onReorderCommit, onHoldToOrder, showGrips, onDropEnd, onReleaseWithoutDrop, externalSelectedIds, onSelectedIdsChange, currentIsSource }: TrackListProps & { onAddToPlaylist?: (tracks: Track[]) => void }) {
  const [internalSelectMode, setInternalSelectMode] = useState(false)
  const selectMode = externalSelectMode !== undefined ? externalSelectMode : internalSelectMode
  const setSelectMode = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? (v as (prev: boolean) => boolean)(selectMode) : v
    if (onExternalSelectModeChange) onExternalSelectModeChange(next)
    else setInternalSelectMode(next)
  }
  const [internalSelectedIds, setInternalSelectedIds] = useState<Set<string>>(new Set())
  // Shared selection when controlled, private otherwise.
  const selectedIds = externalSelectedIds ?? internalSelectedIds
  const setSelectedIds = (
    updater: Set<string> | ((prev: Set<string>) => Set<string>),
  ) => {
    const next = typeof updater === 'function'
      ? (updater as (prev: Set<string>) => Set<string>)(selectedIds)
      : updater
    if (onSelectedIdsChange) onSelectedIdsChange(next)
    else setInternalSelectedIds(next)
  }
  useEffect(() => {
    if (selectAllTrigger && selectAllTrigger > 0) {
      setSelectedIds(new Set(tracks.map(t => t.id)))
    }
  }, [selectAllTrigger, tracks])
  useEffect(() => {
    if (selectClearTrigger && selectClearTrigger > 0) {
      setSelectedIds(new Set())
    }
  }, [selectClearTrigger])

  // Single always-mounted Reorder tree: live order during drags, one
  // full-order commit at drop (orderByIds). Remount key covers track, select,
  // selection size, AND container geometry (resize/tilt) — order flips excluded
  // (the hold fire flips visual mode in the same tick as controls.start).
  const listRef = useRef<HTMLDivElement | null>(null)
  const rowIds = useMemo(() => tracks.map((t) => t.id), [tracks])
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  useEffect(() => { setDragIds(null) }, [reorderMode, tracks, currentTrackIndex])
  const dragIdsRef = useRef<string[] | null>(null)
  useEffect(() => { dragIdsRef.current = dragIds }, [dragIds])
  // Live mirror (framer 14 handles the cadence — the old 120ms throttle broke
  // number updates and needed wiggling to register slots). The drop commit
  // reads the same ref, so precision never depends on render timing.
  const latestIdsRef = useRef<string[] | null>(null)
  const queueReorder = (ids: string[]) => {
    latestIdsRef.current = ids
    setDragIds(ids)
  }
  // Which row is being dragged (set at dragstart): the scroll-slot sync
  // measures geometry relative to this id.
  const draggedIdRef = useRef<string | null>(null)
  // A drag is active between any row's dragstart and its drop: native scroll
  // must stay out (framer autoscrolls programmatically) or the two scrollers
  // fight and measurements drift.
  const [dragActive, setDragActive] = useState(false)
  // Scroll-driven slot sync: framer's check-reorder returns early when pointer
  // velocity is zero, so a parked finger in the autoscroll zone scrolls the
  // list while slots (and the number badges) freeze. The sync re-checks
  // geometry on every container scroll; the DOM==mirror guard skips frames
  // where framer's own reorder hasn't rendered yet, so the two never fight.
  const syncNow = useScrollSlotSync({
    containerRef: listRef,
    active: dragActive,
    draggedIdRef,
    getIds: () => latestIdsRef.current ?? dragIdsRef.current ?? rowIds,
    setIds: queueReorder,
    label: 'lib',
  })
  const displayTracks = useMemo(() => {
    const ordered = orderByIds(tracks, (t) => t.id, dragIds ?? rowIds)
    return ordered ?? tracks
  }, [tracks, dragIds, rowIds])
  // Highlight follows the track id, so it stays put while rows slide under it.
  const displayCurrentIdx = (() => {
    const curId = tracks[currentTrackIndex]?.id
    if (curId == null) return currentTrackIndex
    const i = displayTracks.findIndex((t) => t.id === curId)
    return i === -1 ? currentTrackIndex : i
  })()
  const groupValues = useMemo(() => displayTracks.map((t) => t.id), [displayTracks])
  const soundingId = `${tracks[currentTrackIndex]?.id ?? 'boot'}|${selectMode ? 's' : ''}|${selectedIds.size}`
  const [layoutNonce, setLayoutNonce] = useState(0)
  useEffect(() => {
    const onResize = () => setLayoutNonce((n) => n + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  const commitDragMove = () => {
    // Final geometry check before commit: a scroll in the last frames may not
    // have had a rAF tick yet — land the drop where the row actually is.
    syncNow()
    // The hold path blocks scrolling for the whole gesture: always release it
    // at drop, changed or not.
    unblockTouchScroll()
    setDragActive(false)
    dropCommittedRef.current = true
    dropStampRef.current = Date.now()
    onDropEnd?.()
    const ids = latestIdsRef.current ?? dragIdsRef.current
    if (!ids) return
    const ordered = orderByIds(tracks, (t) => t.id, ids)
    // No-op drops (released where it started) commit nothing.
    if (ordered && ordered.some((t, i) => t.id !== tracks[i]?.id)) onReorderCommit?.(ids)
  }

  // Release-without-drop in a hold-entered session exits it (see prop note).
  // dropCommittedRef distinguishes a real drop (commit ran) from a bare lift.
  const dropCommittedRef = useRef(false)
  // Timestamp of the last drop commit: row clicks inside 300ms of it are the
  // release itself, not taps.
  const dropStampRef = useRef(0)
  useEffect(() => {
    dropCommittedRef.current = false
  }, [reorderMode])
  const handleReleaseUp = () => {
    unblockTouchScroll()
    setDragActive(false)
    window.setTimeout(() => {
      if (!dropCommittedRef.current) onReleaseWithoutDrop?.()
      dropCommittedRef.current = false
    }, 0)
  }

  // Row-level hold entry (no delegation needed — every row owns its controls).
  const holdToOrder = !selectMode && onHoldToOrder ? () => onHoldToOrder() : undefined

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
    <div className="relative flex h-full flex-col">
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

      <div
        data-dragscroll
        className={`flex-1 overflow-y-auto px-2 py-2 pb-24 ${dragActive ? 'touch-none' : ''}`}
        ref={listRef}
        onPointerUp={() => {
          handleReleaseUp()
        }}
        onPointerCancel={() => {
          unblockTouchScroll()
        }}
      >
        <Reorder.Group
          key={`${soundingId}|${layoutNonce}`}
          axis="y"
          values={groupValues}
          onReorder={(ids) => queueReorder(ids)}
        >
          <AnimatePresence initial={false}>
            {displayTracks.map((track, index) => (
              <DragTrackRow
                key={track.id}
                track={track}
                index={index}
                isCurrent={index === displayCurrentIdx}
                currentIsSource={currentIsSource}
                selectMode={selectMode}
                isSelected={selectedIds.has(track.id)}
                onToggleSelect={() => toggleSelect(track.id)}
                showGrip={!!reorderMode && showGrips !== false}
                holdToOrder={holdToOrder}
                dropStampRef={dropStampRef}
                onPlay={() => onSelectTrack(index)}
                onCommitMove={commitDragMove}
                onDragBegin={(id) => {
                  draggedIdRef.current = id
                  setDragActive(true)
                }}
              />
            ))}
          </AnimatePresence>
        </Reorder.Group>
      </div>

      {/* Selection action bar — absolute overlay: mounting/unmounting must
          never change the list geometry (container shifts invalidate the drag
          tree's measurements = edge pile-ups). Permanent bottom padding above
          reserves its space. */}
      <AnimatePresence>
        {selectMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ y: 60 }}
            animate={{ y: 0 }}
            exit={{ y: 60 }}
            className="absolute inset-x-0 bottom-0 z-10 border-t border-slate-800 bg-slate-900 px-4 py-3"
          >
            <div className="flex items-center justify-center gap-3">
              {onAddToPlaylist && (
                <button
                  onClick={() => {
                    const selected = tracks.filter((t) => selectedIds.has(t.id))
                    onAddToPlaylist(selected)
                  }}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
                >
                  Add to playlist ({selectedIds.size})
                </button>
              )}
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
