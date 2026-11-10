import { useState, useEffect, useMemo } from 'react'
import type { Track } from '../../lib/types'
import { getAllTracks } from '../../lib/idb'
import { TrackList } from './TrackList'

interface Props {
  open: boolean
  playlistName: string
  onClose: () => void
  onAdd: (tracks: Track[]) => Promise<void>
}

/**
 * Reverse of AddToPlaylistSheet: opened from INSIDE a playlist, picks tracks
 * from the library (search + forced select) and appends them. Duplicates
 * allowed — the items model gives each its own occurrence id.
 */
export function AddTracksSheet({ open, playlistName, onClose, onAdd }: Props) {
  const [library, setLibrary] = useState<Track[]>([])
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!open) return
    setSearch('')
    setSelectedIds(new Set())
    void getAllTracks().then(setLibrary).catch(() => setLibrary([]))
  }, [open])

  const query = search.trim().toLowerCase()
  const visible = useMemo(
    () => (query ? library.filter((t) => t.name.toLowerCase().includes(query)) : library),
    [library, query],
  )
  const selected = useMemo(() => visible.filter((t) => selectedIds.has(t.id)), [visible, selectedIds])

  if (!open) return null

  const handleAdd = async () => {
    if (selected.length === 0 || adding) return
    setAdding(true)
    try {
      await onAdd(selected)
      onClose()
    } finally {
      setAdding(false)
    }
  }

  const noop = () => {}

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950">
      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">← Back</button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-white">Add to {playlistName?.trim() ? playlistName : 'Untitled'}</h2>
            <p className="text-xs text-slate-400">{selectedIds.size} selected • dupes allowed</p>
          </div>
        </div>
        <div className="mt-3">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search library..." className="w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {library.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-500">Library is empty — add tracks first.</p>
        ) : (
          <TrackList
            tracks={visible}
            currentTrackIndex={-1}
            onSelectTrack={noop}
            onPickFolder={noop}
            onPickFiles={noop}
            hideHeader
            externalSelectMode
            externalSelectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
          />
        )}
      </div>
      <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
        <button onClick={handleAdd} disabled={selected.length === 0 || adding} className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-light active:scale-[0.98] disabled:opacity-50">
          {adding ? 'Adding...' : `Add ${selected.length} track${selected.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}
