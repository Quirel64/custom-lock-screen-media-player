import { useState, useMemo, useEffect } from 'react'
import { motion } from 'framer-motion'
import type { Track } from '../../lib/types'
import { groupTracks } from '../../lib/group'
import { TrackList } from '../playlist/TrackList'
import { getFileFromOPFS } from '../../lib/opfs'
import { getTrackThumbnail } from '../../lib/thumbnail'

interface Props {
  tracks: Track[]
  currentTrackIndex: number
  onSelectTrack: (index: number) => void
  onPickFolder: () => void
  onPickFiles: () => void
  onRemoveTracks?: (tracks: Track[]) => void
}

export function LibraryView({ tracks, currentTrackIndex, onSelectTrack, onPickFolder, onPickFiles, onRemoveTracks }: Props) {
  const [mode, setMode] = useState<'groups' | 'queue'>('groups')
  const [search, setSearch] = useState('')
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})

  const grouped = useMemo(() => groupTracks(tracks, { minGroupSize: 2 }), [tracks])

  // Lazy thumbnails: only first 4 per group + visible loose (limit 24 total) to avoid OPFS churn on iOS
  useEffect(() => {
    let cancelled = false
    const toLoad: Track[] = []
    for (const g of grouped.groups) for (let i = 0; i < Math.min(4, g.tracks.length); i++) toLoad.push(g.tracks[i])
    for (let i = 0; i < Math.min(100, grouped.loose.length); i++) toLoad.push(grouped.loose[i])
    const uniq = [...new Map(toLoad.map((t) => [t.fileName, t] as const)).values()]
    const missing = uniq.filter((t) => !thumbs[t.fileName])
    if (missing.length === 0) return
    ;(async () => {
      for (const t of missing) {
        if (cancelled) break
        try {
          const file = await getFileFromOPFS(t.fileName)
          if (!file || cancelled) continue
          const url = await getTrackThumbnail(file, t.mediaType)
          if (url && !cancelled) setThumbs((prev) => (prev[t.fileName] ? prev : { ...prev, [t.fileName]: url }))
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [grouped.groups, grouped.loose])
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

  const handleSelectInGroup = (track: Track) => {
    const idx = tracks.findIndex((t) => t.id === track.id)
    if (idx !== -1) onSelectTrack(idx)
  }

  if (tracks.length === 0) {
    return <TrackList tracks={tracks} currentTrackIndex={currentTrackIndex} onSelectTrack={onSelectTrack} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} />
  }

  // Group detail view
  if (activeGroup) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">
          <button onClick={() => setActiveGroupId(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{activeGroup.name}</h2>
            <p className="text-xs text-slate-400">{activeGroup.tracks.length} tracks • {activeGroup.reason.split(' score')[0]}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {activeGroup.tracks.map((t) => {
            const qIdx = tracks.findIndex((x) => x.id === t.id)
            const isPlaying = qIdx === currentTrackIndex
            return (
              <div key={t.id} onClick={() => handleSelectInGroup(t)} className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 ${isPlaying ? 'bg-primary/20 text-primary-light' : 'hover:bg-slate-800/50 text-slate-300'}`}>
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-slate-800 text-xs">{t.mediaType === 'video' ? '🎬' : '🎵'}</div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{t.name}</p>
                  <p className="truncate text-xs text-slate-500">{t.artist !== 'Unknown Artist' ? t.artist : t.folderName} • {(t.duration ? `${Math.floor(t.duration/60)}:${String(Math.floor(t.duration%60)).padStart(2,'0')}` : '--:--')}</p>
                </div>
                {isPlaying && <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: title + toggle */}
      <div className="border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Library</h2>
            <p className="text-xs text-slate-400">{tracks.length} tracks • {grouped.groups.length} groups • {grouped.loose.length} loose</p>
          </div>
          <div className="flex items-center gap-1 rounded-full bg-slate-800 p-1">
            <button onClick={() => setMode('groups')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'groups' ? 'bg-primary text-white' : 'text-slate-400'}`}>Groups</button>
            <button onClick={() => setMode('queue')} className={`rounded-full px-3 py-1 text-xs font-medium ${mode === 'queue' ? 'bg-primary text-white' : 'text-slate-400'}`}>Queue</button>
          </div>
        </div>
        {mode === 'groups' && (
          <div className="mt-3 flex gap-2">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search groups or tracks..." className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={onPickFolder} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Folder</button>
            <button onClick={onPickFiles} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300">+ Files</button>
          </div>
        )}
      </div>

      {mode === 'queue' ? (
        <TrackList tracks={tracks} currentTrackIndex={currentTrackIndex} onSelectTrack={onSelectTrack} onPickFolder={onPickFolder} onPickFiles={onPickFiles} onRemoveTracks={onRemoveTracks} hideHeader />
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {filteredGroups.length === 0 && filteredLoose.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No matches for "{query}" — try search term appears in track name (e.g. omori, mario)</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredGroups.map((g) => (
                <motion.button
                  key={g.id}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setActiveGroupId(g.id)}
                  className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left"
                >
                  <div className="grid h-28 grid-cols-2 gap-0.5 bg-slate-800 p-0.5">
                    {[0, 1, 2, 3].map((i) => {
                      const t = g.tracks[i]
                      if (!t) return <div key={i} className="bg-slate-700" />
                      if (i === 3 && g.tracks.length > 4) return <div key={i} className="flex items-center justify-center bg-slate-700 text-sm font-semibold text-slate-300">+{g.tracks.length - 3}</div>
                      const thumb = t ? thumbs[t.fileName] : undefined
                      return (
                        <div key={i} className="flex items-center justify-center overflow-hidden bg-slate-700 text-[10px] text-slate-300">
                          {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" /> : t.mediaType === 'video' ? '🎬' : '🎵'}
                        </div>
                      )
                    })}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="truncate pr-1 text-sm font-medium text-white">{g.name}</p>
                    <p className="pr-1 text-xs text-slate-400">{g.tracks.length} tracks</p>
                  </div>
                </motion.button>
              ))}
              {filteredLoose.map((t) => {
                const thumb = thumbs[t.fileName]
                return (
                  <motion.button
                    key={t.id}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => handleSelectInGroup(t)}
                    className="flex flex-col overflow-hidden rounded-lg bg-slate-900 text-left"
                  >
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
          <p className="mt-3 text-center text-[10px] text-slate-500">Dynamic groups from filename (high-score 2+ tokens). Singles searchable. Tap group to open, track to play in queue.</p>
        </div>
      )}
    </div>
  )
}
