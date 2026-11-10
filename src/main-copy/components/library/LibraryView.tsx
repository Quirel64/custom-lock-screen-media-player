import { useState, useMemo, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Track } from '../../lib/types'
import { groupTracks } from '../../lib/group'
import { TrackList } from '../playlist/TrackList'
import { PlayingIndicator } from '../ui/PlayingIndicator'
import { usePlayerStore } from '../../stores/playerStore'
import { queueKey, findQueueIndexByKey, orderByIds } from '../../lib/queue'
import { getTrackFile } from '../../lib/idb'
import { getTrackThumbnail, getCachedThumbnails, loadPersistedThumbnails, canProbeNow } from '../../lib/thumbnail'

interface Props {
  tracks: Track[]
  onSelectTrack: (index: number, ordered?: Track[]) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
  onAddToPlaylist?: (tracks: Track[]) => void
  // Membership (any order): gates Order mode + playing-vs-source dots. Stays
  // true through session reorders (exact-sequence checks would fail there).
  libraryMembership?: boolean
  currentTrackId?: string | null
  // Gapless session reorder plumbing from the engine (App passes through).
  onReorderQueue?: (newQueue: Track[], newIndex: number) => void
}

export function LibraryView({ tracks, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks, onAddToPlaylist, libraryMembership = true, currentTrackId = null, onReorderQueue }: Props) {
  const [mode, setMode] = useState<'groups' | 'queue'>('groups')
  const [search, setSearch] = useState('')
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  // S1: ONE select mode + ONE selection set for the whole Library (queue mode,
  // group detail, and later the grid) — Back preserves selection, no loose states.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set())
  // #10 library session reorder: view-owned display order (ids). Canonical
  // `tracks` stays the truth for uploads/deletes; a membership mismatch falls
  // back to canonical automatically. Order mode is queue-only and gated on the
  // live queue actually being the library (reordering a playlist's queue from
  // here would clobber it).
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null)
  const [orderMode, setOrderMode] = useState(false)
  // Grips are exclusive to button-entered Order mode (accessibility); hold
  // entries drag gesturally and need no handle.
  const [gripsVisible, setGripsVisible] = useState(true)
  const orderedTracks = useMemo(() => {
    if (!orderOverride || orderOverride.length !== tracks.length) return tracks
    const byId = new Map(tracks.map((t) => [t.id, t] as const))
    if (!orderOverride.every((id) => byId.has(id))) return tracks
    return orderOverride.map((id) => byId.get(id)!)
  }, [tracks, orderOverride])
  // Row highlight by track id: correct in canonical AND session order.
  const queueRowIdx = currentTrackId ? orderedTracks.findIndex((t) => t.id === currentTrackId) : -1
  const [queueSelectAllTrigger, setQueueSelectAllTrigger] = useState(0)
  const [queueSelectClearTrigger, setQueueSelectClearTrigger] = useState(0)
  const [selectAllOn, setSelectAllOn] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string>>(() => getCachedThumbnails())
  const [probeTick, setProbeTick] = useState(0)

  const grouped = useMemo(() => groupTracks(tracks, { minGroupSize: 2 }), [tracks])

  // Lazy thumbnails: first 4 per group + visible loose (limit 24 total) to avoid IndexedDB churn on iOS.
  // S3: when a group is open, load ALL its members (cap 40) so detail rows show thumbs too.
  // Probing pauses while audio plays by default (a parked seek probe registers
  // a competing lock-screen timeline). `canProbeNow()` owns the gate; the
  // EventLog toggle can allow seekless-only probes during playback.
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
    const toLoad: Track[] = []
    const open = activeGroupId ? grouped.groups.find((g) => g.id === activeGroupId) : null
    if (open) {
      for (let i = 0; i < Math.min(40, open.tracks.length); i++) toLoad.push(open.tracks[i])
    } else {
      for (const g of grouped.groups) for (let i = 0; i < Math.min(4, g.tracks.length); i++) toLoad.push(g.tracks[i])
      for (let i = 0; i < Math.min(100, grouped.loose.length); i++) toLoad.push(grouped.loose[i])
    }
    const uniq = [...new Map(toLoad.map((t) => [t.fileName, t] as const)).values()]
    const missing = uniq.filter((t) => !thumbs[t.fileName])
    if (missing.length === 0) return
    ;(async () => {
      for (const t of missing) {
        if (cancelled || !canProbeNow()) break
        try {
          const file = await getTrackFile(t.fileName)
          if (!file || cancelled) continue
          const url = await getTrackThumbnail(file, t.mediaType, t.fileName)
          if (url && !cancelled) setThumbs((prev) => (prev[t.fileName] ? prev : { ...prev, [t.fileName]: url }))
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [grouped.groups, grouped.loose, activeGroupId, isPlayingProbe, probeTick])
  const query = search.trim().toLowerCase()

  const filteredGroups = useMemo(() => {
    if (!query) return grouped.groups
    return grouped.groups.filter((g) => g.name.toLowerCase().includes(query) || g.tracks.some((t) => t.name.toLowerCase().includes(query)))
  }, [grouped.groups, query])

  const filteredLoose = useMemo(() => {
    if (!query) return grouped.loose
    return grouped.loose.filter((t) => t.name.toLowerCase().includes(query))
  }, [grouped.loose, query])

  const activeGroup = activeGroupId ? grouped.groups.find((g) => g.id === activeGroupId) ?? null : null

  // S2: shared select-mode helpers for the grid (queue mode keeps its triggers).
  const toggleSelectMode = () => { setSelectMode(v => !v); setSelectAllOn(false); setOrderMode(false) }
  // #10: order mode is mutually exclusive with select mode.
  const toggleOrderMode = () => {
    if (orderMode) { setOrderMode(false); return }
    setOrderMode(true); setGripsVisible(true); setSelectMode(false); setSelectAllOn(false)
  }
  // Single-hold entry: no remount, no handoff — the held row's own controls
  // start the same gesture, visual mode flips alongside.
  const holdToOrder =
    libraryMembership && !selectMode
      ? () => {
          if (!orderMode) {
            setGripsVisible(false)
            setOrderMode(true)
          }
        }
      : undefined
  const toggleTrackSelected = (id: string) => {
    setSelectedTrackIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleQueueSelectAll = () => {
    if (selectAllOn) {
      setQueueSelectClearTrigger(v => v + 1)
      setSelectAllOn(false)
    } else {
      setQueueSelectAllTrigger(v => v + 1)
      setSelectAllOn(true)
    }
  }
  const toggleGridSelectAll = () => {
    if (selectAllOn) {
      setSelectedTrackIds(new Set())
      setSelectAllOn(false)
    } else {
      const visible = new Set<string>()
      for (const g of filteredGroups) for (const t of g.tracks) visible.add(t.id)
      for (const t of filteredLoose) visible.add(t.id)
      setSelectedTrackIds(prev => new Set([...prev, ...visible]))
      setSelectAllOn(true)
    }
  }
  const playingVariant = libraryMembership ? 'playing' as const : 'source' as const

  const handleSelectInGroup = (track: Track) => {
    // Resolve through the DISPLAY order so session reorders are honored.
    const idx = orderedTracks.findIndex((t) => t.id === track.id)
    if (idx !== -1) onSelectTrack(idx, orderedTracks)
  }

  // Tap in queue rows: same display-order mapping. The Reorder tree remounts
  // itself on track change, so Order mode survives taps (no rug-sweeping).
  const handleSelectQueueRow = (displayIdx: number) => {
    onSelectTrack(displayIdx, orderedTracks)
  }

  // Session reorder of the library queue: apply the FULL drop order (single
  // splices collapse multi-step drags), then live-map the sounding store queue
  // (same membership — Order toggle is gated on that).
  const commitQueueOrder = (newIds: string[]) => {
    const reordered = orderByIds(orderedTracks, (t) => t.id, newIds)
    if (!reordered || reordered.every((t, i) => t.id === orderedTracks[i]?.id)) return
    setOrderOverride(reordered.map((t) => t.id))
    if (!onReorderQueue) return
    const st = usePlayerStore.getState()
    const byTrackId = new Map(st.queue.map((q) => [q.id, q] as const))
    const newQueue = reordered.map((t) => byTrackId.get(t.id)).filter((t) => t != null)
    if (newQueue.length !== st.queue.length) return
    const cur = st.queue[st.currentTrackIndex]
    const newIndex = cur ? findQueueIndexByKey(newQueue, queueKey(cur)) : st.currentTrackIndex
    onReorderQueue(newQueue, newIndex)
  }

  if (tracks.length === 0) {
    return <TrackList tracks={tracks} currentTrackIndex={-1} onSelectTrack={(i) => onSelectTrack(i, tracks)} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} onAddToPlaylist={onAddToPlaylist} />
  }

  // Group detail view — thumbnail grid like the loose cards (per S3 decision):
  // tap plays, Select-mode tap selects, playing card gets ring + badge dot.
  if (activeGroup) {
    const membersSelected = activeGroup.tracks.filter((t) => selectedTrackIds.has(t.id))
    const detailAllSelected = activeGroup.tracks.length > 0 && membersSelected.length === activeGroup.tracks.length
    const toggleDetailSelectAll = () => {
      if (detailAllSelected) {
        const ids = new Set(activeGroup.tracks.map((t) => t.id))
        setSelectedTrackIds(prev => new Set([...prev].filter((id) => !ids.has(id))))
      } else {
        const ids = activeGroup.tracks.map((t) => t.id)
        setSelectedTrackIds(prev => new Set([...prev, ...ids]))
      }
    }
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          <button onClick={() => setActiveGroupId(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">{activeGroup.name}</h2>
            <p className="text-xs text-slate-400">{selectMode ? `${membersSelected.length} selected • ` : ''}{activeGroup.tracks.length} tracks • {activeGroup.reason.split(' score')[0]}</p>
          </div>
          {selectMode && (
            <button onClick={toggleDetailSelectAll} className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300">{detailAllSelected ? 'Clear' : 'Select All'}</button>
          )}
          <button onClick={toggleSelectMode} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{selectMode ? 'Done' : 'Select'}</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3">
            {activeGroup.tracks.map((t) => {
              const thumb = thumbs[t.fileName]
              const selected = selectedTrackIds.has(t.id)
              const playing = currentTrackId != null && t.id === currentTrackId
              return (
                <motion.button
                  key={t.id}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => { if (selectMode) toggleTrackSelected(t.id); else handleSelectInGroup(t) }}
                  className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${playing || (selectMode && selected) ? 'ring-2 ring-primary' : ''}`}
                >
                  {playing && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                  {selectMode && !playing && (
                    <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                  )}
                  {selectMode && playing && (
                    <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                  )}
                  <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                    {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="truncate pr-1 text-sm font-medium text-white">{t.name}</p>
                    <p className="truncate pr-1 text-xs text-slate-400">{t.artist !== 'Unknown Artist' ? t.artist : t.folderName} • {t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, '0')}` : '--:--'}</p>
                  </div>
                </motion.button>
              )
            })}
          </div>
        </div>
        {selectMode && membersSelected.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
            <div className="flex items-center justify-center gap-3">
              {onAddToPlaylist && (
                <button
                  onClick={() => onAddToPlaylist(membersSelected)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
                >
                  Add to playlist ({membersSelected.length})
                </button>
              )}
              {onRemoveTracks && (
                <button
                  onClick={() => {
                    onRemoveTracks(membersSelected)
                    const ids = new Set(membersSelected.map((t) => t.id))
                    setSelectedTrackIds(prev => new Set([...prev].filter((id) => !ids.has(id))))
                  }}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
                >
                  Delete ({membersSelected.length})
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: title + toggle */}
      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Library</h2>
            <p className="text-xs text-slate-400">{tracks.length} tracks • {grouped.groups.length} groups • {grouped.loose.length} loose</p>
          </div>
          <div className="flex items-center gap-2">
            {selectMode && (
              <button
                onClick={() => { if (mode === 'queue') toggleQueueSelectAll(); else toggleGridSelectAll() }}
                className="rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-300"
              >
                {selectAllOn ? 'Clear' : 'Select All'}
              </button>
            )}
            <button onClick={toggleSelectMode} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${selectMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}>{selectMode ? 'Done' : 'Select'}</button>
            {mode === 'queue' && libraryMembership && onReorderQueue && (
              <button
                onClick={toggleOrderMode}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${orderMode ? 'bg-primary text-white' : 'bg-slate-800 text-slate-300'}`}
                title="Reorder queue (session only — playback continues)"
              >
                {orderMode ? 'Done' : 'Order'}
              </button>
            )}
            <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
              <button onClick={() => setMode('groups')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'groups' ? 'bg-primary text-white' : 'text-slate-400'}`}>Groups</button>
              <button onClick={() => setMode('queue')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'queue' ? 'bg-primary text-white' : 'text-slate-400'}`}>Queue</button>
            </div>
          </div>
        </div>
        {mode === 'groups' && (
          <div className="mt-3 flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search groups or tracks..." className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={onPickFolder} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Folder</button>
            <button onClick={onPickFiles} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Files</button>
          </div>
        )}
        {mode === 'queue' && (
          <div className="mt-3 flex gap-2">
            <button onClick={onPickFolder} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Folder</button>
            <button onClick={onPickFiles} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Files</button>
          </div>
        )}
      </div>

      {mode === 'queue' ? (
        <div className="flex-1 overflow-hidden">
          <TrackList tracks={orderedTracks} currentTrackIndex={queueRowIdx} onSelectTrack={handleSelectQueueRow} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} onAddToPlaylist={onAddToPlaylist} hideHeader externalSelectMode={selectMode} onExternalSelectModeChange={(v) => { setSelectMode(v); if (!v) setSelectAllOn(false) }} selectAllTrigger={queueSelectAllTrigger} selectClearTrigger={queueSelectClearTrigger} externalSelectedIds={selectedTrackIds} onSelectedIdsChange={setSelectedTrackIds} reorderMode={orderMode} onReorderCommit={commitQueueOrder} onHoldToOrder={holdToOrder} showGrips={gripsVisible} onDropEnd={() => { if (!gripsVisible) { setOrderMode(false); setGripsVisible(true) } }} onReleaseWithoutDrop={() => { if (!gripsVisible) { setOrderMode(false); setGripsVisible(true) } }} currentIsSource={!libraryMembership} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {filteredGroups.length === 0 && filteredLoose.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No matches for "{query}" — try search term appears in track name (e.g. omori, mario)</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredGroups.map((g) => {
                const allSelected = g.tracks.length > 0 && g.tracks.every((t) => selectedTrackIds.has(t.id))
                const someSelected = !allSelected && g.tracks.some((t) => selectedTrackIds.has(t.id))
                const hasPlaying = currentTrackId != null && g.tracks.some((t) => t.id === currentTrackId)
                return (
                <motion.button
                    key={g.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setActiveGroupId(g.id)}
                    className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${hasPlaying ? 'ring-2 ring-primary' : selectMode && allSelected ? 'ring-2 ring-primary' : selectMode && someSelected ? 'ring-1 ring-slate-500' : ''}`}
                  >
                  {hasPlaying && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                  {selectMode && allSelected && <span className="absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-white">✓</span>}
                  <div className="grid h-28 grid-cols-2 gap-0.5 bg-slate-800 p-0.5">
{[0, 1, 2, 3].map((i) => {
                      const t = g.tracks[i]
                      if (!t) return <div key={i} className="bg-slate-700" />
                      if (i === 3 && g.tracks.length > 4) return <div key={i} className="flex items-center justify-center bg-slate-700 text-sm font-semibold text-slate-300">+{g.tracks.length - 3}</div>
                      const thumb = thumbs[t.fileName]
                      return (
                        <div key={i} className="flex items-center justify-center overflow-hidden bg-slate-700 text-[10px] text-slate-300">
                          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : t.mediaType === 'video' ? '🎬' : '🎵'}
                        </div>
                      )
                    })}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="truncate pr-1 text-sm font-medium text-white">{g.name}</p>
                    <p className="pr-1 text-xs text-slate-400">{selectMode ? `${g.tracks.filter((t) => selectedTrackIds.has(t.id)).length}/${g.tracks.length} selected` : `${g.tracks.length} tracks`}</p>
                  </div>
                </motion.button>
                )
              })}
              {filteredLoose.map((t) => {
                const thumb = thumbs[t.fileName]
                const selected = selectedTrackIds.has(t.id)
                const playing = currentTrackId != null && t.id === currentTrackId
                return (
                  <motion.button
                    key={t.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { if (selectMode) toggleTrackSelected(t.id); else handleSelectInGroup(t) }}
                    className={`relative flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left ${playing ? 'ring-2 ring-primary' : selectMode && selected ? 'ring-2 ring-primary' : ''}`}
                  >
                    {playing && <span className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60"><PlayingIndicator variant={playingVariant} size="md" /></span>}
                    {selectMode && (
                      <span className={`absolute left-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${selected ? 'bg-primary text-white' : 'border-2 border-slate-500 bg-slate-900/70 text-transparent'}`}>✓</span>
                    )}
                    <div className="flex h-28 items-center justify-center overflow-hidden bg-slate-800">
                      {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="text-2xl">{t.mediaType === 'video' ? '🎬' : '🎵'}</span>}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="truncate pr-1 text-sm font-medium text-white">{t.name}</p>
                      <p className="truncate pr-1 text-xs text-slate-400">{t.duration ? `${Math.floor(t.duration/60)}:${String(Math.floor(t.duration%60)).padStart(2,'0')}` : '--:--'} • loose</p>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          )}
          <p className="mt-3 text-center text-[10px] text-slate-500">Dynamic groups from filename (high-score 2+ tokens). Singles searchable. Tap group to open, track to play in queue.{selectMode ? ' In Select mode, tap loose tracks to select.' : ''}</p>
        </div>
      )}
      {mode === 'groups' && selectMode && selectedTrackIds.size > 0 && (
        <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
          <div className="flex items-center justify-center gap-3">
            {onAddToPlaylist && (
              <button
                onClick={() => onAddToPlaylist(tracks.filter((t) => selectedTrackIds.has(t.id)))}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98]"
              >
                Add to playlist ({selectedTrackIds.size})
              </button>
            )}
            {onRemoveTracks && (
              <button
                onClick={() => {
                  onRemoveTracks(tracks.filter((t) => selectedTrackIds.has(t.id)))
                  setSelectedTrackIds(new Set())
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 active:scale-[0.98]"
              >
                Delete ({selectedTrackIds.size})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
