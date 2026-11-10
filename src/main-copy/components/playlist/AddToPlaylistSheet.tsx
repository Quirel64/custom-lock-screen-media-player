import { useState } from 'react'
import type { Track, Playlist } from '../../lib/types'
import { showError } from '../ui/Toast'

interface Props {
  open: boolean
  tracks: Track[]
  playlists: Playlist[]
  onClose: () => void
  onAdd: (playlistId: string, tracks: Track[]) => Promise<void>
  onCreate: (name: string, tracks: Track[]) => Promise<void>
  onAfterAdd?: () => void
}

export function AddToPlaylistSheet({ open, tracks, playlists, onClose, onAdd, onCreate, onAfterAdd }: Props) {
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  if (!open) return null

  const handleAdd = async (playlistId: string) => {
    await onAdd(playlistId, tracks)
    onClose()
    onAfterAdd?.()
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) { showError('Name required'); return }
    setCreating(true)
    try {
      await onCreate(name, tracks)
      setNewName('')
      onClose()
      onAfterAdd?.()
    } finally { setCreating(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-slate-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-12 rounded-full bg-slate-700" />
        <h3 className="mb-1 text-sm font-semibold text-white">Add {tracks.length} tracks to playlist</h3>
        <p className="mb-3 text-xs text-slate-400">Duplicates allowed — same track can be added multiple times</p>

        <div className="mb-3 rounded-lg bg-slate-800 p-3">
          <div className="mb-2 flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New playlist name" className="flex-1 rounded-lg bg-slate-700 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-primary" />
            <button onClick={handleCreate} disabled={creating} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{creating ? '...' : 'Create'}</button>
          </div>
          <p className="text-[11px] text-slate-500">Creates playlist with these tracks in order</p>
        </div>

        <div className="max-h-64 overflow-y-auto">
          {playlists.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">No playlists yet — create one above</p>
          ) : (
            playlists.map(pl => (
              <button key={pl.id} onClick={() => void handleAdd(pl.id)} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left hover:bg-slate-800">
                <div>
                  <p className="text-sm text-white">{pl.name}</p>
                  <p className="text-xs text-slate-400">{pl.items.length} tracks</p>
                </div>
                <span className="text-xs text-primary">+ Add</span>
              </button>
            ))
          )}
        </div>

        <button onClick={onClose} className="mt-3 w-full rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-300">Cancel</button>
      </div>
    </div>
  )
}
