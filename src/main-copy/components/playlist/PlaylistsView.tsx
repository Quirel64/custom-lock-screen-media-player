import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence, Reorder, useDragControls } from 'framer-motion'
import type { Track, Playlist } from '../../lib/types'
import { usePlayerStore } from '../../stores/playerStore'
import { orderByIds } from '../../lib/queue'
import { getAllTracks } from '../../lib/idb'
import { getTrackFile } from '../../lib/idb'
import { getTrackThumbnail, getCachedThumbnails, loadPersistedThumbnails, canProbeNow } from '../../lib/thumbnail'
import { showError } from '../ui/Toast'
import { addLog } from '../../lib/logger'
import { PlayingIndicator } from '../ui/PlayingIndicator'
import { HoldRing } from '../ui/HoldRing'
// TEMP-TELEMETRY (scroll-drift diagnosis — remove with the onDrag hooks)
import { telemetryDragSample } from '../../lib/dragTelemetry'
import { useHoldToDrag, unblockTouchScroll } from '../ui/useHoldToDrag'
import { useScrollSlotSync } from '../ui/useScrollSlotSync'
import { AddTracksSheet } from './AddTracksSheet'

interface Props {
  playlists: Playlist[]
  onCreatePlaylist: (name: string, tracks?: Track[]) => Promise<void>
  onForcePlayPlaylist: (id: string, startIdx?: number) => void
  onDeletePlaylist: (id: string) => void
  onRemoveFromPlaylist?: (playlistId: string, itemIds: string[]) => Promise<void>
  onAddTracksToPlaylist?: (playlistId: string, tracks: Track[]) => Promise<void>
  onReorderItems?: (playlistId: string, newItemIds: string[]) => Promise<void>
  currentTrackId?: string | null
  // Phase 3: occurrence-aware highlight — matches the exact queue occurrence
  // (playlist item id), so twin entries no longer light up together.
  currentQueueKey?: string | null
}

// Hold-and-drag queue row in the single always-mounted Reorder tree: grip-only
// dragging (dragListener={false}) so scroll works everywhere else; row holds
// start on the same live controls. select-none stops iOS text selection.
function DragPlaylistRow({ itemId, track, position, isPlaying, editMode, isSelected, onToggleSelect, showGrip, onHoldToOrder, dropStampRef, onPlay, onCommitMove, onDragBegin }: {
  itemId: string
  track: Track
  position: number
  isPlaying: boolean
  editMode: boolean
  isSelected: boolean
  onToggleSelect: () => void
  showGrip: boolean
  onHoldToOrder?: () => void
  dropStampRef: React.RefObject<number>
  onPlay: () => void
  onCommitMove: () => void
  onDragBegin: (id: string) => void
}) {
  const controls = useDragControls()
  const hold = useHoldToDrag({
    shouldStart: () => !editMode && !!onHoldToOrder,
    onStarting: () => onHoldToOrder?.(),
    onFire: (e) => {
      try {
        controls.start(e)
        // TEMP-TELEMETRY (hold-drag diagnosis — remove once green)
        addLog('hold fire: drag live (playlist)')
      } catch {
        // TEMP-TELEMETRY (hold-drag diagnosis — remove once green)
        addLog('hold fire: start threw (playlist)')
      }
    },
  })
  const lifted = hold.dragging
  const rowRef = useRef<HTMLLIElement | null>(null)
  return (
    <Reorder.Item
      ref={rowRef}
      value={itemId}
      data-drag-id={itemId}
      dragListener={false}
      dragControls={controls}
      whileDrag={{ scale: 1.04, boxShadow: '0 10px 28px rgba(0,0,0,0.5)' }}
      exit={{ opacity: 0 }}
      onDragStart={() => onDragBegin(itemId)}
      onDragEnd={() => onCommitMove()}
      onDrag={(_e, info) => {
        telemetryDragSample('pl', rowRef.current, info.point.y)
      }}
      onClick={() => {
        if (Date.now() - dropStampRef.current < 300) return
        if (editMode) onToggleSelect()
        else onPlay()
      }}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      className={`flex cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2 ${
        hold.dragging ? 'touch-none' : 'touch-pan-y'
      } ${
        lifted ? 'relative z-10' : ''
      } ${isPlaying ? 'bg-primary/20 text-primary-light' : 'hover:bg-slate-800/50 text-slate-300'}`}
    >
      <div className="flex w-8 items-center justify-center">
        {hold.holdArmed ? (
          <HoldRing />
        ) : editMode ? (
          <div className={`h-5 w-5 rounded border-2 ${isSelected ? 'border-primary bg-primary' : 'border-slate-600'}`}>{isSelected && <svg viewBox="0 0 16 16" className="h-full w-full text-white" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" /></svg>}</div>
        ) : showGrip ? (
        <span
          onPointerDown={(e) => controls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab touch-none rounded px-1.5 py-2 text-sm leading-none text-slate-500 hover:bg-slate-700 hover:text-white active:cursor-grabbing"
          title="Hold and drag to reorder"
        >
          ⋮⋮
        </span>
        ) : (
          <span className="text-xs text-slate-500">{position}</span>
        )}
      </div>
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-xs">{track.mediaType === 'video' ? '🎬' : '🎵'}</div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{track.name}</p>
        <p className="truncate text-xs text-slate-500">{track.artist !== 'Unknown Artist' ? track.artist : track.folderName}</p>
      </div>
      {isPlaying && <PlayingIndicator variant="playing" />}
    </Reorder.Item>
  )
}

export function PlaylistsView({ playlists, onCreatePlaylist, onForcePlayPlaylist, onDeletePlaylist, onRemoveFromPlaylist, onAddTracksToPlaylist, onReorderItems, currentTrackId, currentQueueKey }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeTracks, setActiveTracks] = useState<Track[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [showAddTracks, setShowAddTracks] = useState(false)
  const [newName, setNewName] = useState('')
  const [viewMode, setViewMode] = useState<'tracks' | 'queue'>('tracks')
  const [editMode, setEditMode] = useState(false)
  const [orderMode, setOrderMode] = useState(false)
  const [gripsVisible, setGripsVisible] = useState(true)
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set())
  const [thumbs, setThumbs] = useState<Record<string, string>>(() => getCachedThumbnails())
  const [trackFileNameById, setTrackFileNameById] = useState<Record<string, string>>({})
  const [probeTick, setProbeTick] = useState(0)

  const active = activeId ? playlists.find(p => p.id === activeId) ?? null : null

  // Resolve tracks for active playlist
  useEffect(() => {
    if (!active) { setActiveTracks([]); return }
    let cancelled = false
    ;(async () => {
      const all = await getAllTracks()
      const map = new Map(all.map(t => [t.id, t] as const))
      const resolved: Track[] = []
      for (const item of active.items) {
        const t = map.get(item.trackId)
        if (t) resolved.push(t)
      }
      if (!cancelled) setActiveTracks(resolved)
    })()
    return () => { cancelled = true }
  }, [active])

  // Thumbnails for active detail and grid. Persisted per file, so probes are
  // one-time. `canProbeNow()` handles playback pause + seek/hidden cooldown.
  const isPlayingProbe = usePlayerStore((s) => s.isPlaying)
  useEffect(() => {
    let cancelled = false
    void loadPersistedThumbnails().then((stored) => {
      if (!cancelled && Object.keys(stored).length > 0) setThumbs((prev) => ({ ...stored, ...prev }))
    })
    const onResume = () => setProbeTick((v) => v + 1)
    window.addEventListener('thumb-probes-resume', onResume)
    return () => { cancelled = true; window.removeEventListener('thumb-probes-resume', onResume) }
  }, [])
  useEffect(() => {
    let cancelled = false
    const toLoad: { fileName: string, track: Track }[] = []
    if (active && activeTracks.length > 0) {
      const items = viewMode === 'tracks' ? activeTracks : activeTracks.slice(0, 4)
      items.forEach(t => { if (!thumbs[t.fileName]) toLoad.push({ fileName: t.fileName, track: t }) })
      if (toLoad.length === 0) return
      ;(async () => {
        for (const { track } of toLoad) {
          if (cancelled || !canProbeNow()) break
          try {
            const file = await getTrackFile(track.fileName)
            if (!file || cancelled) continue
            const url = await getTrackThumbnail(file, track.mediaType, track.fileName)
            if (url && !cancelled) setThumbs(prev => prev[track.fileName] ? prev : { ...prev, [track.fileName]: url })
          } catch {}
        }
      })()
    }
    return () => { cancelled = true }
  }, [active, activeTracks, viewMode, thumbs, isPlayingProbe, probeTick])

  // Grid thumbnails for playlist overview (first 4 per playlist). Same
  // probe-hygiene as above: never while audio plays.
  useEffect(() => {
    if (active) return
    let cancelled = false
    ;(async () => {
      const all = await getAllTracks()
      const map = new Map(all.map(t => [t.id, t] as const))
      if (cancelled) return
      // Playlist items reference trackId; thumbnails are keyed by fileName.
      const byId: Record<string, string> = {}
      for (const t of all) byId[t.id] = t.fileName
      setTrackFileNameById(byId)
      const toLoad: Track[] = []
      for (const pl of playlists) {
        for (let i = 0; i < Math.min(4, pl.items.length); i++) {
          const t = map.get(pl.items[i].trackId)
          if (t && !thumbs[t.fileName] && !toLoad.find(x => x.fileName === t.fileName)) toLoad.push(t)
        }
      }
      for (const t of toLoad) {
        if (cancelled || !canProbeNow()) break
        try {
          const file = await getTrackFile(t.fileName)
          if (!file || cancelled) continue
          const url = await getTrackThumbnail(file, t.mediaType, t.fileName)
          if (url && !cancelled) setThumbs(prev => prev[t.fileName] ? prev : { ...prev, [t.fileName]: url })
        } catch {}
      }
    })()
    return () => { cancelled = true }
  }, [playlists, active, thumbs, isPlayingProbe, probeTick])

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) { showError('Name required'); return }
    await onCreatePlaylist(name, [])
    setNewName('')
    setShowCreate(false)
  }

  const toggleSelect = (itemId: string) => {
    setSelectedItemIds(prev => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId)
      return next
    })
  }

  // Single always-mounted Reorder tree: live order during drags, one
  // full-order commit at drop (orderByIds). Remount key covers track, edit,
  // selection size, AND geometry (resize/tilt) — order flips excluded (the
  // hold fire flips visual mode in the same tick as controls.start).
  const queueListRef = useRef<HTMLDivElement | null>(null)
  const [dragItemIds, setDragItemIds] = useState<string[] | null>(null)
  useEffect(() => { setDragItemIds(null) }, [orderMode, activeId, playlists, currentQueueKey, currentTrackId])
  const dragItemIdsRef = useRef<string[] | null>(null)
  useEffect(() => { dragItemIdsRef.current = dragItemIds }, [dragItemIds])
  // Live mirror (framer 14 handles the cadence — throttling broke number
  // updates and needed wiggling to register slots).
  const latestIdsRef = useRef<string[] | null>(null)
  const queueReorder = (ids: string[]) => {
    latestIdsRef.current = ids
    setDragItemIds(ids)
  }
  const displayItemIds: string[] = useMemo(() => {
    if (!active) return []
    const ordered = orderByIds(active.items, (it) => it.id, dragItemIds ?? [])
    return (ordered ?? active.items).map((it) => it.id)
  }, [dragItemIds, active])
  const soundingKey = `${currentQueueKey ?? currentTrackId ?? 'boot'}|${editMode ? 'e' : ''}|${selectedItemIds.size}`
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
  // A drag is active between any row's dragstart and its drop: native scroll
  // must stay out (framer autoscrolls programmatically) or the two scrollers
  // fight and measurements drift.
  const [dragActive, setDragActive] = useState(false)
  // Which row is being dragged (set at dragstart): the scroll-slot sync
  // measures geometry relative to this id.
  const draggedIdRef = useRef<string | null>(null)
  // Scroll-driven slot sync (same as the library list): framer freezes slots
  // when pointer velocity is zero; scroll events re-check geometry instead.
  const syncNow = useScrollSlotSync({
    containerRef: queueListRef,
    active: dragActive,
    draggedIdRef,
    getIds: () => latestIdsRef.current ?? dragItemIdsRef.current ?? displayItemIds,
    setIds: queueReorder,
    label: 'pl',
  })
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
    // Hold-entered sessions (grips hidden) exit on drop — quick in-and-out.
    if (!gripsVisible) {
      setOrderMode(false)
      setGripsVisible(true)
    }
    const ids = latestIdsRef.current ?? dragItemIdsRef.current
    if (!ids || !active || !onReorderItems) return
    const ordered = orderByIds(active.items, (it) => it.id, ids)
    // No-op drops (released where it started) commit nothing.
    if (!ordered || ordered.every((it, i) => it.id === active.items[i]?.id)) return
    void onReorderItems(active.id, ids)
  }
  // Release-without-drop exits a hold-entered session (deferred past the
  // drop commit — unmounting first would eat the reorder).
  const dropCommittedRef = useRef(false)
  // Timestamp of the last drop commit: row clicks inside 300ms of it are the
  // release itself, not taps.
  const dropStampRef = useRef(0)
  useEffect(() => {
    dropCommittedRef.current = false
  }, [orderMode])
  const handleReleaseUp = () => {
    unblockTouchScroll()
    setDragActive(false)
    window.setTimeout(() => {
      if (!dropCommittedRef.current && !gripsVisible) {
        setOrderMode(false)
        setGripsVisible(true)
      }
      dropCommittedRef.current = false
    }, 0)
  }

  // Row-level hold entry (no delegation — every row owns its controls).
  const holdToOrder =
    !orderMode && !editMode && onReorderItems
      ? () => {
          setGripsVisible(false)
          setOrderMode(true)
        }
      : undefined

  const handleRemoveSelected = async () => {
    if (!active || selectedItemIds.size === 0 || !onRemoveFromPlaylist) return
    await onRemoveFromPlaylist(active.id, Array.from(selectedItemIds))
    setSelectedItemIds(new Set())
    setEditMode(false)
  }

  // Active playlist detail
  if (active) {
    const isQueue = viewMode === 'queue'
    return (
      <div className="flex h-full flex-col">
        <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => { setActiveId(null); setEditMode(false); setOrderMode(false); setSelectedItemIds(new Set()); setViewMode('tracks') }} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-white">{active.name?.trim() ? active.name : 'Untitled'}</h2>
              <p className="text-xs text-slate-400">{active.items.length} tracks {active.items.length !== activeTracks.length ? `(${activeTracks.length} available)` : ''}</p>
            </div>
            <button onClick={() => { setEditMode(v => !v); setOrderMode(false) }} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${editMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{editMode ? 'Done' : 'Edit'}</button>
            {onReorderItems && (
              <button
                onClick={() => { if (viewMode !== 'queue') setViewMode('queue'); setOrderMode(v => !v); setGripsVisible(true); setEditMode(false) }}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${orderMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}
                title="Reorder tracks (playback continues)"
              >
                {orderMode ? 'Done' : 'Order'}
              </button>
            )}
            {onAddTracksToPlaylist && (
              <button onClick={() => setShowAddTracks(true)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200" title="Add tracks from the library">+ Tracks</button>
            )}
            <button onClick={() => onForcePlayPlaylist(active.id, 0)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white">Play</button>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
              <button onClick={() => setViewMode('tracks')} className={`rounded-full px-3 py-1 text-xs font-medium ${viewMode === 'tracks' ? 'bg-primary text-white' : 'text-slate-400'}`}>Tracks</button>
              <button onClick={() => setViewMode('queue')} className={`rounded-full px-3 py-1 text-xs font-medium ${viewMode === 'queue' ? 'bg-primary text-white' : 'text-slate-400'}`}>Queue</button>
            </div>
            <div className="flex items-center gap-2">
              {editMode && (
                <button onClick={() => setSelectedItemIds(s => s.size === active!.items.length ? new Set() : new Set(active!.items.map(it => it.id)))} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">{selectedItemIds.size === active?.items.length ? 'Deselect All' : 'Select All'}</button>
              )}
              {editMode && <span className="text-xs text-slate-400">{selectedItemIds.size} selected</span>}
            </div>
          </div>
        </div>

        {active.items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-slate-500">
            <div>
              <div className="mb-2 text-3xl">📋</div>
              <p className="text-sm">No tracks yet</p>
              <p className="text-xs">Add from Library via Select → Add to playlist</p>
            </div>
          </div>
        ) : isQueue ? (
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <div
              className={`flex-1 overflow-y-auto p-2 pb-24 ${dragActive ? 'touch-none' : ''}`}
              data-dragscroll
              ref={queueListRef}
              onPointerUp={() => {
                handleReleaseUp()
              }}
              onPointerCancel={() => {
                unblockTouchScroll()
              }}
            >
                <Reorder.Group
                  key={`${soundingKey}|${layoutNonce}`}
                  axis="y"
                  values={displayItemIds}
                  onReorder={(ids) => queueReorder(ids)}
                >
                <AnimatePresence initial={false}>
                  {displayItemIds.map((iid, pos) => {
                    const idx = active.items.findIndex((it) => it.id === iid)
                    const t = activeTracks[idx]
                    if (idx === -1 || !t) return null
                    const playing = currentQueueKey != null ? iid === currentQueueKey : currentTrackId === t.id
                    return (
                      <DragPlaylistRow
                        key={iid}
                        itemId={iid}
                        track={t}
                        position={pos + 1}
                        isPlaying={playing}
                        editMode={editMode}
                        isSelected={selectedItemIds.has(iid)}
                        onToggleSelect={() => toggleSelect(iid)}
                        showGrip={orderMode && gripsVisible}
                        onHoldToOrder={holdToOrder}
                        dropStampRef={dropStampRef}
                        onPlay={() => onForcePlayPlaylist(active.id, idx)}
                        onCommitMove={commitDragMove}
                        onDragBegin={(id) => {
                          draggedIdRef.current = id
                          setDragActive(true)
                        }}
                      />
                    )
                  })}
                </AnimatePresence>
              </Reorder.Group>
            </div>
            {editMode && (
              <div className="absolute inset-x-0 bottom-0 z-10 border-t border-slate-800 bg-slate-900 px-4 py-3">
                <div className="flex gap-2">
                  <button onClick={handleRemoveSelected} disabled={selectedItemIds.size === 0} className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Remove from playlist ({selectedItemIds.size})</button>
                  <button onClick={() => onDeletePlaylist(active.id)} className="rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-300">Delete playlist</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-3">
{activeTracks.map((t, idx) => {
                const thumb = thumbs[t.fileName]
                const gridItemId = active.items[idx]?.id ?? t.id
                const gridSelected = selectedItemIds.has(gridItemId)
                const gridPlaying = currentQueueKey != null
                  ? gridItemId === currentQueueKey
                  : currentTrackId === t.id
                return (
                  <button key={`${gridItemId}-${idx}`} onClick={() => { if (editMode) toggleSelect(gridItemId); else onForcePlayPlaylist(active.id, idx) }} className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${gridPlaying || (editMode && gridSelected) ? 'ring-2 ring-primary' : ''}`}>
                    {gridPlaying && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant="playing" size="md" /></span>}
                    {editMode && (
                      <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${gridSelected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                    )}
                    <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="truncate text-sm font-medium text-white">{t.name}</p>
                      <p className="truncate text-xs text-slate-400">{idx + 1} • {t.artist !== 'Unknown Artist' ? t.artist : t.folderName}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          {editMode && (
            <div className="border-t border-slate-800 bg-slate-900 px-4 py-3">
              <div className="flex gap-2">
                <button onClick={handleRemoveSelected} disabled={selectedItemIds.size === 0} className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Remove from playlist ({selectedItemIds.size})</button>
                <button onClick={() => onDeletePlaylist(active.id)} className="rounded-lg bg-red-900/30 px-3 py-2 text-sm text-red-300">Delete playlist</button>
              </div>
            </div>
          )}
          </div>
        )}
        {!editMode && active.items.length > 0 && isQueue && (
          <div className="border-t border-slate-800 p-3 text-center text-[11px] text-slate-500">Queue shows playlist order. Use Edit to remove tracks (playlist only, library untouched).</div>
        )}
        {showAddTracks && onAddTracksToPlaylist && (
          <AddTracksSheet
            open={showAddTracks}
            playlistName={active.name}
            onClose={() => setShowAddTracks(false)}
            onAdd={async (tracks) => { await onAddTracksToPlaylist(active.id, tracks) }}
          />
        )}
      </div>
    )
  }

  // List view
  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Playlists</h2>
            <p className="text-xs text-slate-400">{playlists.length} playlists</p>
          </div>
          <button onClick={() => setShowCreate(v => !v)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white">+ Create</button>
        </div>
        {showCreate && (
          <div className="mt-3 flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Playlist name" className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" onKeyDown={e => { if (e.key === 'Enter') void handleCreate() }} />
            <button onClick={handleCreate} className="rounded-lg bg-slate-700 px-3 py-2 text-sm text-white">Save</button>
          </div>
        )}
      </div>
      {playlists.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="text-slate-500">
            <div className="mb-2 text-4xl">📋</div>
            <p className="text-sm">No playlists yet</p>
            <p className="mt-1 text-xs">Select tracks in Library → Add to playlist, or create one above</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3">
            {playlists.map(p => (
              <motion.button key={p.id} whileTap={{ scale: 0.97 }} onClick={() => setActiveId(p.id)} className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left">
                <div className="grid h-28 grid-cols-2 gap-0.5 bg-slate-800 p-0.5">
                  {/* 2x2 cover art from the first 4 items; +N overlay on the 4th */}
                  {(() => {
                    return [0,1,2,3].map(i => {
                      const item = p.items[i]
                      if (!item) return <div key={i} className="bg-slate-700 flex items-center justify-center text-slate-500 text-xs">—</div>
                      const fileName = trackFileNameById[item.trackId]
                      const url = fileName ? thumbs[fileName] : undefined
                      const overflow = i === 3 && p.items.length > 4
                      if (!url) return <div key={i} className="bg-slate-700 flex items-center justify-center text-slate-500">📋</div>
                      return (
                        <div key={i} className="relative overflow-hidden bg-slate-700">
                          <img src={url} alt="" className="h-full w-full object-cover" />
                          {overflow && (
                            <span className="absolute bottom-0 right-0 rounded-tl bg-slate-900/80 px-1.5 text-xs font-semibold text-slate-200">+{p.items.length - 4}</span>
                          )}
                        </div>
                      )
                    })
                  })()}
                </div>
                <div className="px-3 py-2.5">
                  <p className="truncate text-sm font-medium text-white">{p.name?.trim() ? p.name : 'Untitled'}</p>
                  <p className="text-xs text-slate-400">{p.items.length} tracks</p>
                </div>
              </motion.button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
