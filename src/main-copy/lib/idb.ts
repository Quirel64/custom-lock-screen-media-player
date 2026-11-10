import { openDB, deleteDB as deleteDatabase, type IDBPDatabase, type DBSchema } from 'idb'
import type { Track, Playlist } from './types'

const DB_NAME = 'media-player-db-copy' // CARBON-COPY SCOPE PATCH: isolated DB; the live media-player-db (same Pages origin) is at version 5+ and owns the real library
const DB_VERSION = 5
const TRACKS_STORE = 'tracks'
const PLAYLISTS_STORE = 'playlists'
const SETTINGS_STORE = 'settings'
const FILES_STORE = 'files'
const THUMBS_STORE = 'thumbs'

interface MediaDB extends DBSchema {
  [TRACKS_STORE]: {
    key: string
    value: Track
    indexes: { 'by-folder': string; 'by-name': string; 'by-createdAt': number }
  }
  [PLAYLISTS_STORE]: {
    key: string
    value: Playlist
  }
  [SETTINGS_STORE]: {
    key: string
    value: unknown
  }
  [FILES_STORE]: {
    key: string
    value: File
  }
  [THUMBS_STORE]: {
    key: string
    value: string
  }
}

let dbInstance: IDBPDatabase<MediaDB> | null = null

async function getDB(): Promise<IDBPDatabase<MediaDB>> {
  if (dbInstance) return dbInstance
  dbInstance = await openDB<MediaDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const tracksStore = db.createObjectStore(TRACKS_STORE, { keyPath: 'id' })
        tracksStore.createIndex('by-folder', 'folderName')
        tracksStore.createIndex('by-name', 'name')
        tracksStore.createIndex('by-createdAt', 'createdAt')
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' })
        db.createObjectStore(SETTINGS_STORE)
      }
      if (oldVersion < 2) {
        db.createObjectStore(FILES_STORE)
      }
      if (oldVersion < 3) {
        const tracksStore = transaction.objectStore(TRACKS_STORE)
        if (!tracksStore.indexNames.contains('by-createdAt')) {
          tracksStore.createIndex('by-createdAt', 'createdAt')
        }
      }
      if (oldVersion < 5) {
        db.createObjectStore(THUMBS_STORE)
      }
      if (oldVersion < 4) {
        // Migrate legacy playlists (tracks: Track[]) to items: PlaylistItem[] for duplicate support
        const playlistsStore = transaction.objectStore(PLAYLISTS_STORE)
        void playlistsStore.getAll().then((playlists) => {
          for (const pl of playlists as unknown as { id: string; tracks?: import('./types').Track[]; items?: import('./types').PlaylistItem[]; name: string; createdAt: number; updatedAt: number }[]) {
            if ((!pl.items || pl.items.length === 0) && pl.tracks && pl.tracks.length > 0) {
              const items = pl.tracks.map((t, idx) => ({
                id: crypto.randomUUID(),
                trackId: t.id,
                order: idx,
                addedAt: Date.now() + idx,
              }))
              const migrated = { ...pl, items, tracks: pl.tracks } as unknown as import('./types').Playlist
              playlistsStore.put(migrated)
            } else if (!pl.items) {
              const migrated = { ...pl, items: [] as import('./types').PlaylistItem[], tracks: pl.tracks ?? [] } as unknown as import('./types').Playlist
              playlistsStore.put(migrated)
            }
          }
        })
      }
    },
  })
  return dbInstance
}

export async function saveTrack(track: Track): Promise<void> {
  const db = await getDB()
  await db.put(TRACKS_STORE, track)
}

export async function saveTracks(tracks: Track[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(TRACKS_STORE, 'readwrite')
  // Queue all puts without per-put await to keep transaction alive and flush in one commit
  const puts = tracks.map((track) => tx.store.put(track))
  await Promise.all(puts)
  await tx.done
  // Fallback verification: if transaction aborted (iOS suspend), try per-track puts
  try {
    const check = await db.getAllKeys(TRACKS_STORE)
    if (check.length !== tracks.length) {
      for (const t of tracks) await db.put(TRACKS_STORE, t)
    }
  } catch { /* verify is best-effort */ }
}

export async function getTrack(id: string): Promise<Track | undefined> {
  const db = await getDB()
  return db.get(TRACKS_STORE, id)
}

export async function getAllTracks(): Promise<Track[]> {
  const db = await getDB()
  const tracks = await db.getAll(TRACKS_STORE)
  // Insertion-order: sort by createdAt (UUID ids are random, so key order scatters)
  return tracks.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

export async function getTracksByFolder(folderName: string): Promise<Track[]> {
  const db = await getDB()
  return db.getAllFromIndex(TRACKS_STORE, 'by-folder', folderName)
}

export async function deleteTrack(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(TRACKS_STORE, id)
}

export async function clearAllTracks(): Promise<void> {
  const db = await getDB()
  await db.clear(TRACKS_STORE)
  db.close()
  dbInstance = null
}

export async function resetDB(): Promise<void> {
  dbInstance = null
  await deleteDatabase(DB_NAME)
}

function normalizePlaylist(pl: Playlist): Playlist {
  // Ensure items exists; migrate legacy tracks if needed
  if (!pl.items) (pl as unknown as { items: import('./types').PlaylistItem[] }).items = []
  if ((pl.items.length === 0) && pl.tracks && pl.tracks.length > 0) {
    pl.items = pl.tracks.map((t, idx) => ({
      id: crypto.randomUUID(),
      trackId: t.id,
      order: idx,
      addedAt: Date.now() + idx,
    }))
  }
  // Ensure order is sequential and items sorted by order
  pl.items.sort((a, b) => a.order - b.order)
  pl.items.forEach((it, idx) => { it.order = idx })
  return pl
}

export async function savePlaylist(playlist: Playlist): Promise<void> {
  const db = await getDB()
  // For new playlists, tracks is kept in sync from items for easy debugging
  if (playlist.items && playlist.items.length > 0) {
    // Optionally sync tracks from items if we have all tracks in DB — caller should handle
  } else if (!playlist.items) {
    playlist.items = []
  }
  await db.put(PLAYLISTS_STORE, playlist)
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  const db = await getDB()
  const pl = await db.get(PLAYLISTS_STORE, id) as Playlist | undefined
  if (!pl) return undefined
  return normalizePlaylist(pl)
}

export async function getAllPlaylists(): Promise<Playlist[]> {
  const db = await getDB()
  const pls = await db.getAll(PLAYLISTS_STORE) as Playlist[]
  return pls.map(normalizePlaylist)
}

export function createPlaylistItem(trackId: string, order: number): import('./types').PlaylistItem {
  return { id: crypto.randomUUID(), trackId, order, addedAt: Date.now() }
}

export async function resolvePlaylistTracks(playlist: Playlist, allTracks: Map<string, import('./types').Track>): Promise<import('./types').Track[]> {
  const normalized = normalizePlaylist(playlist)
  const resolved: import('./types').Track[] = []
  for (const item of normalized.items) {
    const t = allTracks.get(item.trackId)
    if (t) resolved.push(t)
  }
  return resolved
}

export async function deletePlaylist(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(PLAYLISTS_STORE, id)
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const db = await getDB()
  await db.put(SETTINGS_STORE, value as never, key)
}

export async function getSetting(key: string): Promise<unknown> {
  const db = await getDB()
  return db.get(SETTINGS_STORE, key)
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (navigator.storage && navigator.storage.persist) {
    const result = await navigator.storage.persist()
    return result
  }
  return false
}

export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  }
  return null
}

// Phase 1b: truthful readout. navigator.storage.estimate() severely under-reports
// on iOS Safari/PWA (0.57MB shown for a real 1.1GB library — WebKit doesn't count
// IndexedDB File blobs). Track.size metadata sum needs no blob reads (safe on
// iPhone 12 with 57+ tracks) and matches Safari Settings webdata.
export interface StorageReport {
  trackCount: number
  blobCount: number
  metadataBytes: number
  thumbCount: number
  thumbBytes: number
  estimateUsage: number | null
  estimateQuota: number | null
}

export async function getTruthfulStorageReport(): Promise<StorageReport> {
  const [tracks, blobNames, thumbStats, est] = await Promise.all([
    getAllTracks().catch(() => [] as Track[]),
    getAllFileBlobNames().catch(() => [] as string[]),
    getThumbnailStats().catch(() => ({ count: 0, bytes: 0 })),
    getStorageEstimate(),
  ])
  let metadataBytes = 0
  for (const t of tracks) metadataBytes += t.size || 0
  return {
    trackCount: tracks.length,
    blobCount: blobNames.length,
    metadataBytes,
    thumbCount: thumbStats.count,
    thumbBytes: thumbStats.bytes,
    estimateUsage: est?.usage ?? null,
    estimateQuota: est?.quota ?? null,
  }
}

export async function saveFileBlob(fileName: string, file: File): Promise<void> {
  const db = await getDB()
  await db.put(FILES_STORE, file, fileName)
}

export async function getFileBlob(fileName: string): Promise<File | undefined> {
  const db = await getDB()
  return db.get(FILES_STORE, fileName)
}

export async function deleteFileBlob(fileName: string): Promise<void> {
  const db = await getDB()
  await db.delete(FILES_STORE, fileName)
}

export async function clearFileBlobs(): Promise<void> {
  const db = await getDB()
  await db.clear(FILES_STORE)
  db.close()
  dbInstance = null
}

export async function getAllFileBlobNames(): Promise<string[]> {
  const db = await getDB()
  return db.getAllKeys(FILES_STORE) as Promise<string[]>
}

export async function saveTrackFile(fileName: string, file: File): Promise<void> {
  await saveFileBlob(fileName, file)
}

export async function getTrackFile(fileName: string): Promise<File | null> {
  return (await getFileBlob(fileName)) ?? null
}

export async function getTrackFileURL(fileName: string): Promise<string | null> {
  const file = await getFileBlob(fileName)
  if (!file) return null
  return URL.createObjectURL(file)
}

export async function deleteTrackFile(fileName: string): Promise<void> {
  await deleteFileBlob(fileName)
}

export async function clearTrackFiles(): Promise<void> {
  await clearFileBlobs()
}

export async function listTrackFiles(): Promise<string[]> {
  return getAllFileBlobNames()
}

// Thumbnails (data URLs, keyed by fileName). Persisted so each video is
// probed once per device instead of once per app launch. An EMPTY STRING is
// a persistent "no usable frame exists" marker (dark content), not a URL —
// thumbnail.ts converts it to null so the file is never probed again.
export async function getAllThumbnails(): Promise<Record<string, string>> {
  const db = await getDB()
  const keys = await db.getAllKeys(THUMBS_STORE)
  const values = await Promise.all(keys.map((k) => db.get(THUMBS_STORE, k)))
  const out: Record<string, string> = {}
  keys.forEach((k, i) => {
    const v = values[i]
    if (typeof v === 'string') out[k] = v
  })
  return out
}

export async function saveThumbnail(fileName: string, dataUrl: string): Promise<void> {
  const db = await getDB()
  await db.put(THUMBS_STORE, dataUrl, fileName)
}

export async function deleteThumbnail(fileName: string): Promise<void> {
  const db = await getDB()
  await db.delete(THUMBS_STORE, fileName)
}

export async function clearThumbnails(): Promise<void> {
  const db = await getDB()
  await db.clear(THUMBS_STORE)
}

export async function getThumbnailStats(): Promise<{ count: number; bytes: number }> {
  const db = await getDB()
  const keys = await db.getAllKeys(THUMBS_STORE)
  let bytes = 0
  for (const k of keys) {
    const v = await db.get(THUMBS_STORE, k)
    if (typeof v === 'string') bytes += v.length
  }
  return { count: keys.length, bytes }
}

export async function pruneThumbnails(keepFileNames: Set<string>): Promise<number> {
  const db = await getDB()
  const keys = await db.getAllKeys(THUMBS_STORE)
  const stale = keys.filter((k) => !keepFileNames.has(k))
  if (stale.length === 0) return 0
  const tx = db.transaction(THUMBS_STORE, 'readwrite')
  for (const k of stale) void tx.store.delete(k)
  await tx.done
  return stale.length
}

export async function debugTrackFiles(): Promise<void> {
  const files = await getAllFileBlobNames()
  if (files.length === 0) {
    console.log('No track files stored.')
    return
  }
  console.group(`Track files: ${files.length} file(s)`)
  for (const name of files) {
    const file = await getFileBlob(name)
    if (file) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
      console.log(`${name} — ${sizeMB} MB`)
    }
  }
  console.groupEnd()
}

if (typeof window !== 'undefined') {
  ;(window as any).getStorageEstimate = getStorageEstimate
  ;(window as any).debugTrackFiles = debugTrackFiles
  ;(window as any).getTruthfulStorageReport = getTruthfulStorageReport
}
