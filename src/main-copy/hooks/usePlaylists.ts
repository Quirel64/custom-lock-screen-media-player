import { useCallback, useState, useEffect } from 'react'
import type { Track, Playlist } from '../lib/types'
import { getAllPlaylists, getPlaylist, savePlaylist, deletePlaylist, createPlaylistItem, getAllTracks } from '../lib/idb'
import { toQueueItem } from '../lib/queue'
import { usePlayerStore } from '../stores/playerStore'
import { showError, showSuccess } from '../components/ui/Toast'
import { addLog } from '../lib/logger'

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([])

  const refresh = useCallback(async () => {
    const all = await getAllPlaylists()
    // Filter out library — library is not a user playlist
    const filtered = all.filter(p => p.id !== 'library')
    // Sort by createdAt
    filtered.sort((a, b) => a.createdAt - b.createdAt)
    setPlaylists(filtered)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const createPlaylist = useCallback(async (name: string, tracks: Track[] = []): Promise<Playlist> => {
    const trimmed = name.trim()
    if (!trimmed) { showError('Playlist name required'); throw new Error('empty name') }
    const now = Date.now()
    const items = tracks.map((t, idx) => createPlaylistItem(t.id, idx))
    // Fix addedAt to be sequential
    items.forEach((it, idx) => { it.addedAt = now + idx; it.order = idx })
    const pl: Playlist = {
      id: crypto.randomUUID(),
      name: trimmed,
      tracks: [],
      items,
      createdAt: now,
      updatedAt: now,
    }
    await savePlaylist(pl)
    await refresh()
    addLog(`playlist created "${trimmed}" with ${items.length} tracks`)
    showSuccess(`Playlist "${trimmed}" created`)
    return pl
  }, [refresh])

  const addTracksToPlaylist = useCallback(async (playlistId: string, tracks: Track[]) => {
    const pl = await getPlaylist(playlistId)
    if (!pl) { showError('Playlist not found'); return }
    const baseOrder = pl.items.length
    const now = Date.now()
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      pl.items.push(createPlaylistItem(t.id, baseOrder + i))
      pl.items[pl.items.length - 1].addedAt = now + i
    }
    pl.updatedAt = now
    // Ensure order sequential
    pl.items.forEach((it, idx) => { it.order = idx })
    await savePlaylist(pl)
    await refresh()
    addLog(`added ${tracks.length} tracks to playlist "${pl.name}"`)
    showSuccess(`Added ${tracks.length} tracks to "${pl.name}"`)
  }, [refresh])

  const removePlaylist = useCallback(async (id: string) => {
    await deletePlaylist(id)
    await refresh()
    addLog(`playlist deleted ${id}`)
  }, [refresh])

  // NOTE: track removal lives in App.onRemoveFromPlaylist (it also migrates
  // playback when the sounding occurrence is removed). Do NOT re-add a naive
  // remover here — it would reintroduce the stale-index ghost-audio bug.

  const playPlaylist = useCallback(async (playlistId: string, startItemIndex = 0): Promise<boolean> => {
    const pl = await getPlaylist(playlistId)
    if (!pl || pl.items.length === 0) { showError('Playlist empty'); return false }
    const allTracks = await getAllTracks()
    const trackMap = new Map(allTracks.map(t => [t.id, t] as const))
    const resolved: Track[] = []
    for (const item of pl.items) {
      const t = trackMap.get(item.trackId)
      if (t) resolved.push(toQueueItem(t, item.id))
    }
    if (resolved.length === 0) { showError('No tracks found for playlist'); return false }
    const { setQueue, setOriginalOrder, setCurrentTrackIndex, setPlaying } = usePlayerStore.getState()
    // Clamp start index
    const startIdx = Math.max(0, Math.min(startItemIndex, resolved.length - 1))
    setQueue(resolved)
    setOriginalOrder(resolved)
    setCurrentTrackIndex(startIdx)
    // Fresh queue → stale positional shuffleOrder would point out of range.
    usePlayerStore.getState().syncShuffleToQueue(startIdx)
    setPlaying(true)
    addLog(`play playlist "${pl.name}" ${resolved.length} tracks from #${startIdx}`)
    return true
  }, [])

  return { playlists, refresh, createPlaylist, addTracksToPlaylist, deletePlaylist: removePlaylist, playPlaylist }
}
