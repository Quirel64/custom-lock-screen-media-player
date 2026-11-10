import { useCallback } from 'react'
import type { Track } from '../lib/types'
import { saveTracks, getAllTracks, savePlaylist, resetDB, deleteTrack, getPlaylist, getAllPlaylists, getAllFileBlobNames, getStorageEstimate, saveTrackFile, clearTrackFiles, deleteTrackFile, debugTrackFiles, deleteThumbnail, pruneThumbnails } from '../lib/idb'
import { removeCachedThumbnail, clearThumbnailCache } from '../lib/thumbnail'
import { generateTrackId } from '../lib/shuffle'
import { usePlayerStore } from '../stores/playerStore'
import { addLog } from '../lib/logger'
import { showInfo } from '../components/ui/Toast'

const MEDIA_EXTENSIONS = /\.(mp3|wav|ogg|flac|m4a|aac|wma|opus|mp4|m4v|webm|avi|mkv|mov)$/i
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|avi|mkv|mov)$/i
const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska']

function isMediaFile(file: File): boolean {
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) return true
  return MEDIA_EXTENSIONS.test(file.name)
}

function isVideoFile(file: File): boolean {
  if (VIDEO_MIME_TYPES.includes(file.type) || file.type.startsWith('video/')) return true
  return VIDEO_EXTENSIONS.test(file.name)
}

function getUniqueFileName(existingNames: Set<string>, originalName: string): string {
  if (!existingNames.has(originalName)) {
    existingNames.add(originalName)
    return originalName
  }
  let counter = 1
  const ext = originalName.lastIndexOf('.')
  const base = ext > 0 ? originalName.slice(0, ext) : originalName
  const suffix = ext > 0 ? originalName.slice(ext) : ''
  while (existingNames.has(`${base} (${counter})${suffix}`)) {
    counter++
  }
  const unique = `${base} (${counter})${suffix}`
  existingNames.add(unique)
  return unique
}

async function processFiles(
  files: File[],
  existingQueue: Track[],
  setQueue: (t: Track[]) => void,
  setOriginalOrder: (t: Track[]) => void,
  setCurrentTrackIndex: (i: number) => void
): Promise<Track[] | null> {
  const mediaFiles = files.filter(isMediaFile)

  if (mediaFiles.length === 0) return null

  const folderName =
    mediaFiles[0].webkitRelativePath?.split('/')[0] || 'Selected Files'

  // Phase 1c: canonical base — NEVER build on the transient Zustand queue.
  // That queue may currently be a playlist (full of instanceId occurrences) or
  // stale relative to IDB; persisting it baked queue leaks into TRACKS_STORE
  // (the old dud-stacking path). canonicalBase is also already createdAt-sorted.
  void existingQueue
  const canonicalBase = (await getAllTracks().catch(() => [] as Track[]))
    .filter((t) => !t.instanceId || t.instanceId === t.id)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const existingNames = new Set<string>(canonicalBase.map((t) => t.fileName))
  // Map from uniqueFileName back to original File for duration lookup
  const fileMap = new Map<string, File>()

  // Build track objects first without I/O to assign unique names deterministically
  const baseTime = Date.now()
  const tracks: Track[] = mediaFiles.map((file, idx) => {
    const uniqueFileName = getUniqueFileName(existingNames, file.name)
    fileMap.set(uniqueFileName, file)
    return {
      id: generateTrackId(),
      name: file.name.replace(/\.[^/.]+$/, ''),
      fileName: uniqueFileName,
      size: file.size,
      lastModified: file.lastModified,
      duration: 0,
      artist: extractArtist(file.name),
      album: extractAlbum(file.name),
      folderName,
      mediaType: isVideoFile(file) ? 'video' : 'audio',
      createdAt: baseTime + idx,
    }
  })

  // Persist file blobs sequentially
  for (const track of tracks) {
    const file = fileMap.get(track.fileName)
    if (file) await saveTrackFile(track.fileName, file)
  }

  // Persist metadata immediately with duration 0 so a force-close during
  // duration probing (which can take N*5s) does not lose the entire batch.
  // Stable library order IDs: keep surviving item UUIDs (future reorder/sort
  // depends on them), mint once for newcomers and reuse in the final save.
  const combinedEarly = [...canonicalBase, ...tracks]
  await saveTracks(combinedEarly)
  const prevLib = await getPlaylist('library').catch(() => undefined)
  const itemIdByTrack = new Map<string, { id: string; addedAt: number }>()
  for (const it of prevLib?.items ?? []) {
    if (!itemIdByTrack.has(it.trackId)) itemIdByTrack.set(it.trackId, { id: it.id, addedAt: it.addedAt })
  }
  {
    const nowEarly = Date.now()
    for (const t of combinedEarly) {
      if (!itemIdByTrack.has(t.id)) itemIdByTrack.set(t.id, { id: crypto.randomUUID(), addedAt: nowEarly + itemIdByTrack.size })
    }
  }
  const toLibraryItems = (list: Track[]) => {
    const now = Date.now()
    return list.map((t, idx) => {
      const kept = itemIdByTrack.get(t.id)
      return kept
        ? { id: kept.id, trackId: t.id, order: idx, addedAt: kept.addedAt }
        : { id: crypto.randomUUID(), trackId: t.id, order: idx, addedAt: now + idx }
    })
  }
  try {
    await savePlaylist({
      id: 'library',
      name: 'Library',
      tracks: combinedEarly,
      items: toLibraryItems(combinedEarly),
      createdAt: prevLib?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    })
  } catch { /* playlist is secondary; tracks store is source of truth */ }

  // Get durations using the original File objects (best-effort, does not block initial persistence)
  for (const track of tracks) {
    const file = fileMap.get(track.fileName)
    if (file) {
      try {
        const url = URL.createObjectURL(file)
        const el = track.mediaType === 'video' ? document.createElement('video') : new Audio()
        await new Promise<void>((res) => {
          const timeout = setTimeout(() => {
            URL.revokeObjectURL(url)
            res()
          }, 5000)
          el.onloadedmetadata = () => {
            clearTimeout(timeout)
            const d = el.duration
            track.duration = Number.isFinite(d) && d > 0 ? d : 0
            URL.revokeObjectURL(url)
            res()
          }
          el.onerror = () => {
            clearTimeout(timeout)
            URL.revokeObjectURL(url)
            res()
          }
          el.src = url
        })
      } catch {
        // duration stays 0
      }
    }
  }

  const combined = [...canonicalBase, ...tracks]

  // Save updated durations if any changed (second durable write)
  await saveTracks(combined)

  // Library snapshot reuses the SAME item IDs minted above (no churn).
  const existingPlaylist = await getPlaylist('library').catch(() => undefined)
  const playlist = {
    id: 'library',
    name: 'Library',
    tracks: combined,
    items: toLibraryItems(combined),
    createdAt: existingPlaylist?.createdAt ?? prevLib?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  await savePlaylist(playlist as unknown as import('../lib/types').Playlist)

  // Verify durability — read back and retry once if count mismatched (handles iOS abort before tx.done)
  try {
    const verified = await getAllTracks()
    if (verified.length !== combined.length) {
      addLog(`verify failed: expected ${combined.length} got ${verified.length} — retrying save`)
      await saveTracks(combined)
      const retry = await getAllTracks()
      if (retry.length !== combined.length) addLog(`verify retry still mismatched: ${retry.length}/${combined.length}`)
      else addLog(`verify retry ok: ${retry.length} tracks`)
    } else {
      addLog(`verify ok: ${combined.length} tracks persisted`)
    }
  } catch (e) {
    addLog(`verify error: ${e}`)
  }

  setQueue(combined)
  setOriginalOrder(combined)
  setCurrentTrackIndex(canonicalBase.length)
  // Fresh queue → resync shuffle (fresh cycle from the first new track).
  usePlayerStore.getState().syncShuffleToQueue(canonicalBase.length)

  return tracks
}

// Phase 1a: prune deleted trackIds from EVERY playlist copy (including the
// 'library' tracks[]/items[] snapshots) + resequence order IDs so future
// reorder/sort has stable sequential orders. Best-effort: never throws.
async function prunePlaylistsForDeletedTrackIds(deletedIds: Set<string>): Promise<number> {
  if (deletedIds.size === 0) return 0
  try {
    const all = await getAllPlaylists()
    let pruned = 0
    for (const pl of all) {
      const beforeItems = pl.items.length
      const beforeTracks = Array.isArray(pl.tracks) ? pl.tracks.length : 0
      pl.items = (pl.items ?? []).filter((it) => !deletedIds.has(it.trackId))
      if (Array.isArray(pl.tracks) && pl.tracks.length > 0) {
        pl.tracks = pl.tracks.filter((t) => !deletedIds.has(t.id))
      }
      if (pl.items.length !== beforeItems || (Array.isArray(pl.tracks) ? pl.tracks.length : 0) !== beforeTracks) {
        pl.items.forEach((it, idx) => { it.order = idx })
        pl.updatedAt = Date.now()
        await savePlaylist(pl)
        pruned += (beforeItems - pl.items.length) + (beforeTracks - (Array.isArray(pl.tracks) ? pl.tracks.length : 0))
      }
    }
    if (pruned > 0) addLog(`pruned ${pruned} deleted refs from playlists`)
    return pruned
  } catch (e) {
    addLog(`prune playlists failed: ${e}`)
    return 0
  }
}

export function useFolderPicker() {
  const setQueue = usePlayerStore((s) => s.setQueue)
  const setOriginalOrder = usePlayerStore((s) => s.setOriginalOrder)
  const setCurrentTrackIndex = usePlayerStore((s) => s.setCurrentTrackIndex)

  const pickFolder = useCallback(async (): Promise<Track[] | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.setAttribute('webkitdirectory', '')
      input.setAttribute('directory', '')
      input.multiple = true
      input.accept = 'audio/*,video/*'
      input.style.display = 'none'

      // iOS Safari requires: 1) input appended to DOM, 2) addEventListener not .onchange
      document.body.appendChild(input)

      const cleanup = () => {
        try { document.body.removeChild(input) } catch {}
      }

      input.addEventListener('change', async () => {
        const files = Array.from(input.files || [])
        cleanup()
        if (files.length === 0) { resolve(null); return }
        const existingQueue = usePlayerStore.getState().queue
        const result = await processFiles(files, existingQueue, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }, { once: true })

      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const pickFiles = useCallback(async (): Promise<Track[] | null> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.accept = 'audio/*,video/*,.mp3,.wav,.ogg,.flac,.m4a,.aac,.wma,.opus,.mp4,.m4v,.webm,.avi,.mkv,.mov'
      input.style.display = 'none'

      document.body.appendChild(input)

      const cleanup = () => {
        try { document.body.removeChild(input) } catch {}
      }

      input.addEventListener('change', async () => {
        const files = Array.from(input.files || [])
        cleanup()
        if (files.length === 0) { resolve(null); return }
        const existingQueue = usePlayerStore.getState().queue
        const result = await processFiles(files, existingQueue, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }, { once: true })

      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const loadSavedTracks = useCallback(async (): Promise<Track[]> => {
    // Phase 1b boot reconcile: TRACKS_STORE is canonical. Purges dud metadata
    // (persisted instanceId queue leaks, missing-blob ghosts from pre-1a deletes),
    // frees orphan blobs, and repairs the 'library' snapshot copy (stable item IDs
    // preserved so future reorder/sort keeps working). PWA and Safari-web keep
    // SEPARATE IDB stores on iOS — each reconciles its own.
    try {
      const [all, lib, blobNames] = await Promise.all([
        getAllTracks().catch(() => [] as Track[]),
        getPlaylist('library').catch(() => undefined),
        getAllFileBlobNames().catch(() => [] as string[]),
      ])
      const blobSet = new Set(blobNames)

      // 1. Classify canonical tracks
      const leaked: Track[] = [] // instanceId objects that must never persist
      const validByName = new Map<string, Track>()
      const valid: Track[] = []
      for (const t of all) {
        if (t.instanceId && t.instanceId !== t.id) { leaked.push(t); continue }
        if (!blobSet.has(t.fileName)) continue // missing-blob ghost (handled below)
        valid.push(t)
        if (!validByName.has(t.fileName)) validByName.set(t.fileName, t)
      }
      // Missing-blob duds: metadata in TRACKS_STORE with no file (pre-1a ghosts)
      const validIds = new Set(valid.map((t) => t.id))
      const ghosts = all.filter((t) => !validIds.has(t.id) && !(t.instanceId && t.instanceId !== t.id))

      // 2. Purge dud metadata (never delete a blob still referenced by a valid track —
      // legacy duds can share fileName with the good copy)
      for (const d of [...leaked, ...ghosts]) {
        try { await deleteTrack(d.id) } catch { /* best-effort */ }
        if (!validByName.has(d.fileName)) {
          try { await deleteTrackFile(d.fileName) } catch { /* already gone */ }
        }
      }

      // 3. Free orphan blobs (file with no valid track referencing it)
      let orphanCount = 0
      for (const name of blobNames) {
        if (!validByName.has(name)) {
          try { await deleteTrackFile(name); orphanCount++ } catch { /* best-effort */ }
        }
      }

      // 3b. Drop persisted thumbnails for files that no longer exist.
      const prunedThumbs = await pruneThumbnails(new Set(validByName.keys())).catch(() => 0)
      if (prunedThumbs > 0) addLog(`thumb: pruned ${prunedThumbs} orphaned thumbnail${prunedThumbs === 1 ? '' : 's'}`)

      // 4. Repair library snapshot: tracks[] = valid in createdAt order; items keep
      // stable IDs for surviving trackIds (no UUID churn), new IDs only for newcomers.
      const ordered = [...valid].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      const orderedIds = ordered.map((t) => t.id).join(',')
      const prevIds = Array.isArray(lib?.tracks) ? lib!.tracks.map((t) => t.id).join(',') : null
      const existingItemByTrack = new Map<string, { id: string; addedAt: number }>()
      for (const it of lib?.items ?? []) {
        if (!existingItemByTrack.has(it.trackId)) {
          existingItemByTrack.set(it.trackId, { id: it.id, addedAt: it.addedAt })
        }
      }
      const needsRepair =
        prevIds !== orderedIds ||
        (lib?.items.length ?? -1) !== ordered.length ||
        (lib ? lib.items.some((it) => !validIds.has(it.trackId)) : ordered.length > 0)
      if (needsRepair) {
        const now = Date.now()
        const items = ordered.map((t, idx) => {
          const kept = existingItemByTrack.get(t.id)
          return kept
            ? { id: kept.id, trackId: t.id, order: idx, addedAt: kept.addedAt }
            : { id: crypto.randomUUID(), trackId: t.id, order: idx, addedAt: now + idx }
        })
        await savePlaylist({
          id: 'library',
          name: 'Library',
          tracks: ordered,
          items,
          createdAt: lib?.createdAt ?? now,
          updatedAt: now,
        })
      }
      // Backfill createdAt for very old tracks missing it
      let needsBackfill = false
      for (const t of ordered) {
        if (typeof (t as unknown as { createdAt?: number }).createdAt !== 'number') {
          ;(t as unknown as { createdAt: number }).createdAt = Date.now()
          needsBackfill = true
        }
      }
      if (needsBackfill && ordered.length > 0) await saveTracks(ordered)

      if (leaked.length + ghosts.length + orphanCount > 0 || needsRepair) {
        addLog(`reconcile: ${all.length}→${ordered.length} valid (${leaked.length} queue-leaks, ${ghosts.length} missing-blob duds purged, ${orphanCount} orphan blobs freed${needsRepair ? ', library repaired' : ''})`)
      } else {
        addLog(`reconcile ok: ${ordered.length} tracks, library in sync`)
      }

      if (ordered.length > 0) {
        setQueue(ordered)
        setOriginalOrder(ordered)
        setCurrentTrackIndex(0)
      }
      return ordered
    } catch (e) {
      addLog(`reconcile failed, fallback: ${e}`)
      // Fallback: legacy path (library copy, then createdAt-sorted tracks)
      let tracks: Track[] = []
      try {
        const lib = await getPlaylist('library')
        if (lib && Array.isArray(lib.tracks) && lib.tracks.length > 0) {
          tracks = lib.tracks.filter((t) => !t.instanceId || t.instanceId === t.id)
        } else {
          tracks = await getAllTracks()
        }
      } catch {
        tracks = await getAllTracks()
      }
      if (tracks.length > 0) {
        setQueue(tracks)
        setOriginalOrder(tracks)
        setCurrentTrackIndex(0)
      }
      return tracks
    }
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const clearAll = useCallback(async () => {
    const estBefore = await getStorageEstimate()
    addLog(`clearAll start: estimate=${(estBefore?.usage ?? 0) / (1024*1024)}MB`)
    await clearTrackFiles()
    await resetDB()
    clearThumbnailCache()
    try {
      const cacheNames = await caches.keys()
      for (const name of cacheNames) {
        await caches.delete(name)
        addLog(`cache deleted: ${name}`)
      }
    } catch {}
    let est = await getStorageEstimate()
    addLog(`after cleanup: estimate=${(est?.usage ?? 0) / (1024*1024)}MB`)
    try { await debugTrackFiles() } catch {}
    showInfo('Library cleared.')
    setQueue([])
    setOriginalOrder([])
    setCurrentTrackIndex(0)
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const removeTrack = useCallback(async (track: Track) => {
    await deleteTrackFile(track.fileName)
    try { await deleteThumbnail(track.fileName) } catch { /* best-effort */ }
    removeCachedThumbnail(track.fileName)
    await deleteTrack(track.id)
    // Phase 1a: transactional delete — also prune library copy + all playlist refs
    // so deleted metadata can't resurrect on reload (dud stacking).
    await prunePlaylistsForDeletedTrackIds(new Set([track.id]))
    // Update queue
    const { queue, currentTrackIndex, originalOrder } = usePlayerStore.getState()
    const newQueue = queue.filter((t) => t.id !== track.id)
    const newOriginalOrder = originalOrder.filter((t) => t.id !== track.id)
    setQueue(newQueue)
    setOriginalOrder(newOriginalOrder)
    // Adjust current track index
    if (newQueue.length === 0) {
      setCurrentTrackIndex(0)
    } else if (currentTrackIndex >= newQueue.length) {
      setCurrentTrackIndex(newQueue.length - 1)
    } else {
      setCurrentTrackIndex(currentTrackIndex)
    }
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const removeTracks = useCallback(async (tracks: Track[]) => {
    for (const track of tracks) {
      await deleteTrackFile(track.fileName)
      try { await deleteThumbnail(track.fileName) } catch { /* best-effort */ }
      removeCachedThumbnail(track.fileName)
      await deleteTrack(track.id)
    }
    // Phase 1a: transactional delete — also prune library copy + all playlist refs
    // so deleted metadata can't resurrect on reload (dud stacking).
    await prunePlaylistsForDeletedTrackIds(new Set(tracks.map((t) => t.id)))
    const removedIds = new Set(tracks.map((t) => t.id))
    const { queue, currentTrackIndex, originalOrder } = usePlayerStore.getState()
    const newQueue = queue.filter((t) => !removedIds.has(t.id))
    const newOriginalOrder = originalOrder.filter((t) => !removedIds.has(t.id))
    setQueue(newQueue)
    setOriginalOrder(newOriginalOrder)
    if (newQueue.length === 0) {
      setCurrentTrackIndex(0)
    } else if (currentTrackIndex >= newQueue.length) {
      setCurrentTrackIndex(newQueue.length - 1)
    } else {
      setCurrentTrackIndex(currentTrackIndex)
    }
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  return { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTrack, removeTracks }
}

function extractArtist(fileName: string): string {
  const name = fileName.replace(/\.[^/.]+$/, '')
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (dashMatch) return dashMatch[1].trim()
  return 'Unknown Artist'
}

function extractAlbum(fileName: string): string {
  const name = fileName.replace(/\.[^/.]+$/, '')
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/)
  if (dashMatch) return dashMatch[2].trim()
  return 'Unknown Album'
}
