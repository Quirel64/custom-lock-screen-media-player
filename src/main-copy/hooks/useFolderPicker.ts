import { useCallback } from 'react'
import type { Track } from '../lib/types'
import { saveTracks, getAllTracks, savePlaylist, clearAllTracks, deleteTrack, getPlaylist, requestPersistentStorage } from '../lib/idb'
import { saveFileToOPFS, clearOPFS, deleteFileFromOPFS } from '../lib/opfs'
import { generateTrackId } from '../lib/shuffle'
import { usePlayerStore } from '../stores/playerStore'
import { addLog } from '../lib/logger'

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

  // Request persistent storage while still in user-gesture context (pickFolder/pickFiles click)
  try { await requestPersistentStorage() } catch { /* ignore */ }

  const folderName =
    mediaFiles[0].webkitRelativePath?.split('/')[0] || 'Selected Files'

  const existingNames = new Set<string>(existingQueue.map((t) => t.fileName))
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

  // Persist file blobs sequentially to avoid parallel OPFS directory-handle contention on iOS
  for (const track of tracks) {
    const file = fileMap.get(track.fileName)
    if (file) await saveFileToOPFS(track.fileName, file)
  }

  // Persist metadata immediately with duration 0 so a force-close during
  // duration probing (which can take N*5s) does not lose the entire batch.
  const combinedEarly = [...existingQueue, ...tracks]
  await saveTracks(combinedEarly)
  try {
    const existingPlaylistEarly = await getPlaylist('library')
    await savePlaylist({
      id: 'library',
      name: 'Library',
      tracks: combinedEarly,
      createdAt: existingPlaylistEarly?.createdAt ?? Date.now(),
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

  const combined = [...existingQueue, ...tracks]

  // Save updated durations if any changed (second durable write)
  await saveTracks(combined)

  // Use a consistent ID so the library playlist gets updated, not duplicated
  const existingPlaylist = await getPlaylist('library')
  const playlist = {
    id: 'library',
    name: 'Library',
    tracks: combined,
    createdAt: existingPlaylist?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }
  await savePlaylist(playlist)

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
  setCurrentTrackIndex(existingQueue.length)

  return tracks
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
        // Fire persist request synchronously in the change gesture before any await
        try { void requestPersistentStorage() } catch { /* ignore */ }
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
        try { void requestPersistentStorage() } catch { /* ignore */ }
        const existingQueue = usePlayerStore.getState().queue
        const result = await processFiles(files, existingQueue, setQueue, setOriginalOrder, setCurrentTrackIndex)
        resolve(result)
      }, { once: true })

      input.click()
    })
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const loadSavedTracks = useCallback(async (): Promise<Track[]> => {
    // Prefer playlist 'library' which preserves exact insertion order (append batches).
    // Fallback to getAllTracks sorted by createdAt (UUID key order would scatter).
    let tracks: Track[] = []
    try {
      const lib = await getPlaylist('library')
      if (lib && Array.isArray(lib.tracks) && lib.tracks.length > 0) {
        tracks = lib.tracks
        // Backfill createdAt for old tracks missing it
        let needsBackfill = false
        for (const t of tracks) {
          if (typeof (t as unknown as { createdAt?: number }).createdAt !== 'number') {
            ;(t as unknown as { createdAt: number }).createdAt = Date.now()
            needsBackfill = true
          }
        }
        if (needsBackfill) await saveTracks(tracks)
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
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const clearAll = useCallback(async () => {
    await clearAllTracks()
    await clearOPFS()
    setQueue([])
    setOriginalOrder([])
    setCurrentTrackIndex(0)
  }, [setQueue, setOriginalOrder, setCurrentTrackIndex])

  const removeTrack = useCallback(async (track: Track) => {
    // Remove from OPFS
    await deleteFileFromOPFS(track.fileName)
    // Remove from IndexedDB
    await deleteTrack(track.id)
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
      await deleteFileFromOPFS(track.fileName)
      await deleteTrack(track.id)
    }
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
