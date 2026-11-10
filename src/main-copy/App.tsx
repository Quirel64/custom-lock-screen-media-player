import { useState, useEffect, useCallback } from 'react'
import { Layout } from './components/layout/Layout'
import { Sidebar } from './components/layout/Sidebar'
import { AddView } from './components/layout/AddView'
import { LibraryView } from './components/library/LibraryView'
import { NowPlaying } from './components/player/NowPlaying'
import { PlayBar } from './components/player/PlayBar'
import { useAudioEngine } from './hooks/useAudioEngine'
import { useMediaSession } from './hooks/useMediaSession'
import { useFolderPicker } from './hooks/useFolderPicker'
import { usePlayerStore } from './stores/playerStore'
import { requestPersistentStorage, getSetting, saveSetting, saveTracks } from './lib/idb'
import { ToastContainer } from './components/ui/Toast'
import { EventLog } from './components/ui/EventLog'
import type { TabId } from './components/layout/BottomNav'
import type { Track } from './lib/types'
import type { LockScreenMode } from './lib/types'

export default function App() {
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('library')
  const [nowCollapsed, setNowCollapsed] = useState(false)
  const { queue, currentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex] || null

  const { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTracks } = useFolderPicker()
  const { play, pause, remotePauseOrResume, togglePlay, nextTrack, prevTrack, seek, goToTrack, videoContainerRef } = useAudioEngine()
  const { setHandlers } = useMediaSession()

  useEffect(() => {
    const init = async () => {
      await requestPersistentStorage()
      const savedMode = await getSetting('lockScreenMode') as LockScreenMode | undefined
      if (savedMode === 'skip10' || savedMode === 'prevnext') {
        usePlayerStore.getState().setLockScreenMode(savedMode)
      }
      const tracks = await loadSavedTracks()
      if (tracks.length > 0) {
        setActiveTab('library')
      } else {
        setActiveTab('add')
      }
      setReady(true)
    }
    init()
  }, [])

  // Persist lock screen mode
  const lockScreenMode = usePlayerStore((s) => s.lockScreenMode)
  useEffect(() => {
    saveSetting('lockScreenMode', lockScreenMode)
  }, [lockScreenMode])

  useEffect(() => {
    setHandlers({
      onPlay: play,
      onPause: pause,
      onRemotePauseOrResume: remotePauseOrResume,
      onPrev: prevTrack,
      onNext: nextTrack,
      onSeek: seek,
    })
  }, [play, pause, remotePauseOrResume, prevTrack, nextTrack, seek])

  // Flush queue to IDB on hide/pagehide — best-effort durability for iOS force-close
  useEffect(() => {
    const flush = () => {
      const { queue: q } = usePlayerStore.getState()
      if (q.length === 0) return
      void saveTracks(q)
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  const handleSelectTrack = useCallback(
    (index: number) => {
      goToTrack(index)
    },
    [goToTrack]
  )

  const handlePickFolder = useCallback(async () => {
    const tracks = await pickFolder()
    if (tracks) setActiveTab('library')
  }, [pickFolder])

  const handlePickFiles = useCallback(async () => {
    const tracks = await pickFiles()
    if (tracks) setActiveTab('library')
  }, [pickFiles])

  const handleRemoveTracks = useCallback(async (tracks: Track[]) => {
    await removeTracks(tracks)
  }, [removeTracks])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950">
        <div className="text-center">
          <div className="mb-4 text-4xl animate-pulse">🎵</div>
          <p className="text-sm text-slate-400">Loading...</p>
        </div>
      </div>
    )
  }

  const renderNowPlaying = () => {
    return <NowPlaying currentTrack={currentTrack} videoContainerRef={videoContainerRef} collapsed={nowCollapsed} onToggleCollapsed={() => setNowCollapsed((v) => !v)} />
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'add':
        return <AddView onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} />
      case 'library':
        return (
          <LibraryView
            tracks={queue}
            currentTrackIndex={currentTrackIndex}
            onSelectTrack={handleSelectTrack}
            onPickFolder={handlePickFolder}
            onPickFiles={handlePickFiles}
            onRemoveTracks={handleRemoveTracks}
          />
        )
      case 'playlists':
        return (
          <div className="flex h-full items-center justify-center p-8">
            <div className="text-center text-slate-500">
              <div className="mb-2 text-4xl">📋</div>
              <p className="text-sm">Playlists coming soon</p>
            </div>
          </div>
        )
      case 'logs':
        return (
          <div className="flex h-full flex-col p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold text-white">Debug Log</h2>
              <p className="text-xs text-slate-500">Shows play/pause/handoff and any NotAllowedError — check here after testing on lock screen.</p>
            </div>
            <div className="flex-1 overflow-hidden">
              <EventLog />
            </div>
          </div>
        )
    }
  }

  return (
    <>
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      trackCount={queue.length}
      sidebar={
        <Sidebar
          trackCount={queue.length}
          onPickFolder={handlePickFolder}
          onPickFiles={handlePickFiles}
          onClearAll={clearAll}
        />
      }
      nowPlaying={renderNowPlaying()}
      content={renderContent()}
      player={
        <PlayBar
          currentTrack={currentTrack}
          onTogglePlay={togglePlay}
          onNext={nextTrack}
          onPrev={prevTrack}
          onSeek={seek}
        />
      }
    />
    <ToastContainer />
    </>
  )
}
