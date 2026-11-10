export interface Track {
  id: string
  name: string
  fileName: string
  size: number
  lastModified: number
  duration: number
  artist: string
  album: string
  folderName: string
  mediaType: 'audio' | 'video'
  createdAt: number
  instanceId?: string // per-queue occurrence id (playlist dupes: same Track.id but different instanceId)
}

export interface PlaylistItem {
  id: string // per-occurrence uid, allows same trackId multiple times (soft weighting)
  trackId: string // refs Track.id in TRACKS_STORE, single source of truth, no blob duplication
  order: number // per-playlist order, array index also reflects order but explicit for drag stability
  addedAt: number
}

export interface Playlist {
  id: string
  name: string
  tracks: Track[] // legacy: kept for migration from v1.1.0 library (will be converted to items on load)
  items: PlaylistItem[] // new canonical ordered refs; empty for legacy until migrated
  createdAt: number
  updatedAt: number
}

export interface PlayerState {
  isPlaying: boolean
  currentTrackIndex: number
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  shuffleOn: boolean
  repeatMode: 'off' | 'all' | 'one'
  queue: Track[]
  originalOrder: Track[]
  trackVolumes: Record<string, number>
}

export type RepeatMode = 'off' | 'all' | 'one'
export type LockScreenMode = 'skip10' | 'prevnext'
