import type { Track } from './types'

export interface ShuffleOptions {
  avoidConsecutive?: boolean
  avoidRepeatFirst?: boolean
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function rearrangeNoConsecutive(tracks: Track[]): Track[] {
  const result = [...tracks]
  let maxAttempts = result.length * 10
  let i = 1

  while (i < result.length && maxAttempts > 0) {
    const prev = result[i - 1]
    const curr = result[i]

    if (prev.artist === curr.artist || prev.album === curr.album) {
      let swapIndex = i + 1
      let found = false
      while (swapIndex < result.length) {
        if (result[swapIndex].artist !== prev.artist && result[swapIndex].album !== prev.album) {
          ;[result[i], result[swapIndex]] = [result[swapIndex], result[i]]
          found = true
          break
        }
        swapIndex++
      }
      if (!found) i++
      maxAttempts--
    } else {
      i++
    }
  }

  return result
}

export function shufflePlaylist(tracks: Track[], options: ShuffleOptions = {}): Track[] {
  if (tracks.length <= 1) return [...tracks]

  const shuffled = [...tracks]

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  if (options.avoidConsecutive) {
    return rearrangeNoConsecutive(shuffled)
  }

  return shuffled
}

export function generateTrackId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fallback */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}

export function generatePlaylistId(name: string): string {
  return `playlist-${hashString(name)}-${Date.now()}`
}

export function fisherYatesShuffle<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
