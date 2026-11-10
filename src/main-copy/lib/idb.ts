import { openDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { Track, Playlist } from './types'

const DB_NAME = 'media-player-db'
const DB_VERSION = 3
const TRACKS_STORE = 'tracks'
const PLAYLISTS_STORE = 'playlists'
const SETTINGS_STORE = 'settings'
const FILES_STORE = 'files'

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
    },
  })
  return dbInstance
}

export async function saveTrack(track: Track): Promise<void> {
  try { await requestPersistentStorage() } catch { /* ignore */ }
  const db = await getDB()
  await db.put(TRACKS_STORE, track)
}

export async function saveTracks(tracks: Track[]): Promise<void> {
  try { await requestPersistentStorage() } catch { /* ignore */ }
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
}

export async function savePlaylist(playlist: Playlist): Promise<void> {
  try { await requestPersistentStorage() } catch { /* ignore */ }
  const db = await getDB()
  await db.put(PLAYLISTS_STORE, playlist)
}

export async function getPlaylist(id: string): Promise<Playlist | undefined> {
  const db = await getDB()
  return db.get(PLAYLISTS_STORE, id)
}

export async function getAllPlaylists(): Promise<Playlist[]> {
  const db = await getDB()
  return db.getAll(PLAYLISTS_STORE)
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
}

export async function getAllFileBlobNames(): Promise<string[]> {
  const db = await getDB()
  return db.getAllKeys(FILES_STORE) as Promise<string[]>
}
