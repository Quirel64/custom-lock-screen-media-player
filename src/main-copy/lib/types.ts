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
}

export interface Playlist {
  id: string
  name: string
  tracks: Track[]
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
