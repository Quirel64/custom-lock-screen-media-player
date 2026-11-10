import { create } from 'zustand'
import type { Track, RepeatMode, LockScreenMode } from '../lib/types'
import { fisherYatesShuffle } from '../lib/shuffle'

interface PlayerStore {
  isPlaying: boolean
  currentTrackIndex: number
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  shuffleOn: boolean
  shuffleOrder: number[]
  repeatMode: RepeatMode
  lockScreenMode: LockScreenMode
  queue: Track[]
  originalOrder: Track[]
  trackVolumes: Record<string, number>
  setPlaying: (playing: boolean) => void
  setCurrentTrackIndex: (index: number) => void
  setCurrentTime: (time: number) => void
  setDuration: (duration: number) => void
  setVolume: (volume: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setLockScreenMode: (mode: LockScreenMode) => void
  toggleLockScreenMode: () => void
  setQueue: (tracks: Track[]) => void
  setOriginalOrder: (tracks: Track[]) => void
  setTrackVolume: (trackId: string, volume: number) => void
  setShuffleOrder: (order: number[]) => void
  getNextTrackIndex: () => number | null
  getPrevTrackIndex: () => number | null
  getCurrentTrack: () => Track | null
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  isPlaying: false,
  currentTrackIndex: 0,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isMuted: false,
  shuffleOn: false,
  shuffleOrder: [],
  repeatMode: 'off',
  queue: [],
  originalOrder: [],
  trackVolumes: {},

  lockScreenMode: 'skip10',
  setPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTrackIndex: (index) => set({ currentTrackIndex: index }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (duration) => set({ duration: duration }),
  setVolume: (volume) => set({ volume, isMuted: volume === 0 }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  setShuffleOrder: (order) => set({ shuffleOrder: order }),
  setLockScreenMode: (mode) => set({ lockScreenMode: mode }),
  toggleLockScreenMode: () => set((s) => ({ lockScreenMode: s.lockScreenMode === 'skip10' ? 'prevnext' : 'skip10' })),

  toggleShuffle: () => {
    const { shuffleOn, queue, currentTrackIndex } = get()
    if (!shuffleOn) {
      // Turning shuffle ON: generate a Fisher-Yates shuffled order
      const indices = Array.from({ length: queue.length }, (_, i) => i)
      const shuffled = fisherYatesShuffle(indices)
      // Move current track to front of shuffled order
      const currentPos = shuffled.indexOf(currentTrackIndex)
      if (currentPos > 0) {
        shuffled.splice(currentPos, 1)
        shuffled.unshift(currentTrackIndex)
      }
      set({ shuffleOn: true, shuffleOrder: shuffled })
    } else {
      // Turning shuffle OFF: restore original order
      set({ shuffleOn: false, shuffleOrder: [] })
    }
  },

  cycleRepeat: () =>
    set((s) => ({
      repeatMode: s.repeatMode === 'off' ? 'all' : s.repeatMode === 'all' ? 'one' : 'off',
    })),

  setQueue: (tracks) => set({ queue: tracks }),
  setOriginalOrder: (tracks) => set({ originalOrder: tracks }),
  setTrackVolume: (trackId, volume) =>
    set((s) => ({ trackVolumes: { ...s.trackVolumes, [trackId]: volume } })),

  getNextTrackIndex: () => {
    const { shuffleOn, shuffleOrder, currentTrackIndex, queue, repeatMode } = get()

    if (repeatMode === 'one') return currentTrackIndex

    if (shuffleOn && shuffleOrder.length > 0) {
      const posInShuffle = shuffleOrder.indexOf(currentTrackIndex)
      const nextPos = posInShuffle + 1
      if (nextPos < shuffleOrder.length) {
        return shuffleOrder[nextPos]
      }
      // End of shuffle list
      if (repeatMode === 'all') {
        // Reshuffle and start over
        const indices = Array.from({ length: queue.length }, (_, i) => i)
        const newShuffled = fisherYatesShuffle(indices)
        set({ shuffleOrder: newShuffled })
        return newShuffled[0]
      }
      return null
    }

    // Sequential mode
    if (currentTrackIndex < queue.length - 1) {
      return currentTrackIndex + 1
    }
    if (repeatMode === 'all') return 0
    return null
  },

  getPrevTrackIndex: () => {
    const { shuffleOn, shuffleOrder, currentTrackIndex, queue } = get()

    if (shuffleOn && shuffleOrder.length > 0) {
      const posInShuffle = shuffleOrder.indexOf(currentTrackIndex)
      if (posInShuffle > 0) {
        return shuffleOrder[posInShuffle - 1]
      }
      return shuffleOrder[shuffleOrder.length - 1]
    }

    if (currentTrackIndex > 0) return currentTrackIndex - 1
    return queue.length - 1
  },

  getCurrentTrack: () => {
    const { queue, currentTrackIndex } = get()
    return queue[currentTrackIndex] ?? null
  },
}))
