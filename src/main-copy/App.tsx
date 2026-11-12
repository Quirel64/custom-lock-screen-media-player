import { useState, useEffect, useCallback, useRef } from 'react'
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
import { getSetting, saveSetting, saveTracks, getAllTracks, getPlaylist, savePlaylist } from './lib/idb'
import { queueKey, toQueueItem, isLibraryQueue, findQueueIndexByKey, hasSameTracks, orderByIds } from './lib/queue'
import { addLog } from './lib/logger'
import { isVideoPausedMode, isLockResilientToggle, isLockReviveOnHidden, isVideoDelayedStart, getLockReviveDelay, isMinimalHandlers, isEchoAwareToggle, isLockWarmCycle, getWarmCycleDelay } from './lib/mediaFlags'
import { getProbeDuringPlayback } from './lib/thumbnail'
import { ToastContainer } from './components/ui/Toast'
import { EventLog } from './components/ui/EventLog'
import { PlaylistsView } from './components/playlist/PlaylistsView'
import { AddToPlaylistSheet } from './components/playlist/AddToPlaylistSheet'
import { usePlaylists } from './hooks/usePlaylists'
import type { TabId } from './components/layout/BottomNav'
import type { Track } from './lib/types'
import type { LockScreenMode } from './lib/types'

export default function App() {
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('library')
  const [nowCollapsed, setNowCollapsed] = useState(false)
  const [pendingAddTracks, setPendingAddTracks] = useState<Track[] | null>(null)
  const [libraryTracks, setLibraryTracks] = useState<Track[]>([])
  const { queue, currentTrackIndex } = usePlayerStore()
  const currentTrack = queue[currentTrackIndex] || null

  const { pickFolder, pickFiles, loadSavedTracks, clearAll, removeTracks } = useFolderPicker()
  const { playlists, createPlaylist, addTracksToPlaylist, deletePlaylist, playPlaylist, refresh: refreshPlaylists } = usePlaylists()
  const { play, pause, remotePauseOrResume, togglePlay, nextTrack, prevTrack, seek, goToTrack, reorderQueue, markNextGesture, videoContainerRef } = useAudioEngine()
  const forcePlayPlaylist = useCallback(async (playlistId: string, startItemIndex = 0) => {
    // Only force-reload on success — a failed resolve (empty/missing playlist)
    // must NOT fall through to playing whatever the queue happens to hold.
    const beforeIdx = usePlayerStore.getState().currentTrackIndex
    if (!(await playPlaylist(playlistId, startItemIndex))) return
    // playPlaylist sets the index, which already fires the load effect — call
    // goToTrack (extra force bump) ONLY when the index didn't move, otherwise
    // the track loads TWICE (audible restart stutter). Same-index taps still
    // force a fresh load (needed for playlist dupes).
    if (usePlayerStore.getState().currentTrackIndex === beforeIdx) {
      goToTrack(startItemIndex)
    }
  }, [playPlaylist, goToTrack])
  const { setHandlers, reapplyHandlers, reviveHandlers } = useMediaSession()

  useEffect(() => {
    const init = async () => {
      // Always log experiment flag state at boot: the flags persist in
      // localStorage across force-closes, so every diagnosis needs to know
      // which combination the session actually ran with.
      addLog(`flags: video-paused-mode=${isVideoPausedMode() ? 1 : 0} lock-resilient-toggle=${isLockResilientToggle() ? 1 : 0} lock-revive-on-hidden=${isLockReviveOnHidden() ? 1 : 0} (revive ${getLockReviveDelay()}ms) video-delayed-start=${isVideoDelayedStart() ? 1 : 0} minimal-handlers=${isMinimalHandlers() ? 1 : 0} echo-aware-toggle=${isEchoAwareToggle() ? 1 : 0} lock-warm-cycle=${isLockWarmCycle() ? 1 : 0} (warm ${getWarmCycleDelay()}ms) thumb-probe-play=${getProbeDuringPlayback() ? 1 : 0}`)
      // ARENA ENGINE PORT (round-8 winning combo, pinned ON): the session
      // layer now runs the arena posture regardless of the legacy flags above
      // (which only remain for their still-active video/revive experiments).
      addLog('arena port: playbackState=no-paused echoGate=ON videoTeardown=OFF audioSession=playback presses=engine-aware parkedNav=ON windowsFreezeHold=ON')
      // Fast path first: localStorage reads instantly even when a hot/throttled
      // device takes seconds to open IndexedDB (handlers then apply correctly
      // on the very first lock). IDB confirms afterwards; both stay in sync.
      try {
        const ls = localStorage.getItem('lockScreenMode')
        if (ls === 'skip10' || ls === 'prevnext') {
          usePlayerStore.getState().setLockScreenMode(ls as LockScreenMode)
        }
      } catch { /* private mode — fall through to IDB */ }
      const savedMode = await getSetting('lockScreenMode') as LockScreenMode | undefined
      if (savedMode === 'skip10' || savedMode === 'prevnext') {
        usePlayerStore.getState().setLockScreenMode(savedMode)
      }
      // Phase 1b reconcile inside loadSavedTracks purges duds/orphans and repairs
      // the library copy — no App-side dud filters needed anymore.
      const tracks = await loadSavedTracks()
      setLibraryTracks(tracks)
      if (tracks.length > 0) {
        setActiveTab('library')
      } else {
        setActiveTab('add')
      }
      setReady(true)
    }
    init()
  }, [])

  // Keep libraryTracks in sync when queue is library (not playlist)
  useEffect(() => {
    const sync = async () => {
      setLibraryTracks(await getAllTracks())
    }
    void sync()
  }, [queue.length])

  // Persist lock screen mode (both stores; localStorage is the fast boot path)
  const lockScreenMode = usePlayerStore((s) => s.lockScreenMode)
  useEffect(() => {
    try {
      localStorage.setItem('lockScreenMode', lockScreenMode)
    } catch { /* private mode — IDB still persists */ }
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

  // Experiment (EventLog "Lock revive"): iOS builds the lock-screen UI from the
  // handler set AT LOCK TIME, but our last re-apply happens at play/track
  // change. Greyed, touchless lock controls (reproduced even audio→audio,
  // inconsistently, refresh⇄force-close sensitive) fit a stale/unrouted set.
  // from the handler set — same-set re-applies are inert; a MODE FLIP
  // (skip10⇄prevnext) empirically un-greys wedged lock controls, so the
  // revive flips to the other mode and restores 300ms later. Gated, OFF.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden' && isLockReviveOnHidden()) {
        reviveHandlers()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [reviveHandlers])

  // ARENA PORT (round 12): one-shot attach at the FIRST play per page load.
  // The refresh hole: after a refresh the boot/first-load applies land before
  // iOS has a session to register against, so the handler set is dropped —
  // the first PLAY is the first gesture-adjacent moment iOS accepts a fresh
  // set. Unlike the retired per-unpause edge apply (the triple-tap churn),
  // this fires at most once per page load, so churn stays bounded.
  const isPlayingForEdge = usePlayerStore((s) => s.isPlaying)
  const firstPlayAppliedRef = useRef(false)
  useEffect(() => {
    if (isPlayingForEdge && !firstPlayAppliedRef.current) {
      firstPlayAppliedRef.current = true
      addLog('first-play one-shot handler apply (refresh attach)')
      reapplyHandlers()
    }
  }, [isPlayingForEdge, reapplyHandlers])

  // Flush libraryTracks to IDB on hide/pagehide — best-effort durability for iOS force-close.
  // libraryTracks is canonical by construction (reconcile + queue helpers), so save as-is.
  useEffect(() => {
    const flush = () => {
      if (libraryTracks.length === 0) return
      void saveTracks(libraryTracks)
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
    }
  }, [libraryTracks])

  const handleSelectTrack = useCallback(
    (index: number, ordered?: Track[]) => {
      // Universal reset: every tap restarts fresh, even same fileName/instance.
      // `ordered` is the caller's display order (session reorder); the queue is
      // always built from exactly what the user sees, never assumed canonical.
      markNextGesture()
      const list = ordered ?? libraryTracks
      // If queue is not the displayed list (e.g., playlist, or session order),
      // switch queue to it with instanceIds.
      if (!isLibraryQueue(queue, list) && list.length > 0) {
        const { setQueue, setOriginalOrder, setCurrentTrackIndex: setIdx, setPlaying } = usePlayerStore.getState()
        const withInstance = list.map((t) => toQueueItem(t))
        setQueue(withInstance)
        setOriginalOrder(withInstance)
        setIdx(index)
        // Manual tap with shuffle on = fresh cycle from here (no mid-order end).
        usePlayerStore.getState().syncShuffleToQueue(index)
        setPlaying(true)
      } else {
        // Same: fresh shuffle cycle from the tapped track.
        usePlayerStore.getState().syncShuffleToQueue(index)
        goToTrack(index)
      }
    },
    [goToTrack, markNextGesture, queue, libraryTracks]
  )

  const handlePickFolder = useCallback(async () => {
    const tracks = await pickFolder()
    if (tracks) {
      const all = await getAllTracks()
      setLibraryTracks(all)
      setActiveTab('library')
    }
  }, [pickFolder])

  const handlePickFiles = useCallback(async () => {
    const tracks = await pickFiles()
    if (tracks) {
      const all = await getAllTracks()
      setLibraryTracks(all)
      setActiveTab('library')
    }
  }, [pickFiles])

  const handleRemoveTracks = useCallback(async (tracks: Track[]) => {
    // Capture the sounding occurrence first: same stale-index class of bug as
    // playlist removal — deleting the playing file must migrate, not ghost.
    const before = usePlayerStore.getState()
    const beforeKey = before.queue[before.currentTrackIndex] ? queueKey(before.queue[before.currentTrackIndex]) : null
    const beforeIdx = before.currentTrackIndex
    // Phase 1a: removeTracks() now prunes library copy + playlist refs itself
    // (transactional delete) — here we just refresh library + playlist views.
    await removeTracks(tracks)
    const all = await getAllTracks()
    setLibraryTracks(all)
    await refreshPlaylists()
    const after = usePlayerStore.getState()
    if (after.queue.length === 0) {
      if (beforeKey != null) { try { await pause() } catch { /* best-effort */ } }
      return
    }
    if (beforeKey != null && !after.queue.some((t) => queueKey(t) === beforeKey)) {
      // Sounding file deleted → next in line, previous if it was the last one.
      goToTrack(Math.min(beforeIdx, after.queue.length - 1))
    }
  }, [removeTracks, refreshPlaylists, goToTrack, pause])

  const handleAddToPlaylist = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return
    setPendingAddTracks(tracks)
  }, [])

  const handleCloseSheet = useCallback(() => setPendingAddTracks(null), [])
  const handleAfterAdd = useCallback(() => {
    setPendingAddTracks(null)
    setActiveTab('playlists')
  }, [])

  // #10 reorder: persist the FULL drop order (single splices collapse multi-step
  // drags), then live-map the sounding queue around it (gapless via
  // reorderQueue — audio never restarts). No-ops unless the queue currently IS
  // this playlist.
  const handleReorderPlaylistItems = useCallback(async (playlistId: string, newItemIds: string[]) => {
    const pl = await getPlaylist(playlistId)
    if (!pl) return
    const reordered = orderByIds(pl.items, (it) => it.id, newItemIds)
    // No-op drops (released where it started) persist nothing.
    if (!reordered || reordered.every((it, idx) => it.id === pl.items[idx]?.id)) return
    pl.items = reordered
    pl.items.forEach((it, idx) => { it.order = idx })
    pl.updatedAt = Date.now()
    await savePlaylist(pl)
    await refreshPlaylists()
    const st = usePlayerStore.getState()
    if (st.queue.length !== pl.items.length) return
    const newIds = new Set(pl.items.map((it) => it.id))
    if (!st.queue.every((t) => newIds.has(queueKey(t)))) return
    const allTracks = await getAllTracks()
    const map = new Map(allTracks.map((t) => [t.id, t] as const))
    const newQueue: Track[] = []
    for (const it of pl.items) {
      const t = map.get(it.trackId)
      if (t) newQueue.push(toQueueItem(t, it.id))
    }
    if (newQueue.length !== st.queue.length) return
    const curKey = st.queue[st.currentTrackIndex] ? queueKey(st.queue[st.currentTrackIndex]) : null
    const newIndex = curKey ? findQueueIndexByKey(newQueue, curKey) : -1
    reorderQueue(newQueue, newIndex !== -1 ? newIndex : st.currentTrackIndex)
  }, [refreshPlaylists, reorderQueue])

  // Playlist add that keeps a LIVE playing queue in sync: the queue is a snapshot,
  // so appending items to the playlist otherwise leaves playback (and shuffle /
  // repeat-all, which walk the queue) following the stale order until the next
  // manual tap. If the current queue IS this playlist, append occurrences in
  // place — position and shuffle cycle undisturbed. Library uploads intentionally
  // still jump to the new batch (explicit "play the new stuff" intent).
  const handleAddTracksToPlaylist = useCallback(async (playlistId: string, tracks: Track[]) => {
    await addTracksToPlaylist(playlistId, tracks)
    try {
      const pl = await getPlaylist(playlistId)
      if (!pl || pl.items.length === 0) return
      const st = usePlayerStore.getState()
      if (st.queue.length === 0 || st.queue.length >= pl.items.length) return
      const curKeys = st.queue.map(queueKey)
      const prefixMatches = curKeys.every((k, i) => pl.items[i]?.id === k)
      if (!prefixMatches) return
      const allTracks = await getAllTracks()
      const map = new Map(allTracks.map((t) => [t.id, t] as const))
      const appended: Track[] = []
      for (let i = curKeys.length; i < pl.items.length; i++) {
        const t = map.get(pl.items[i].trackId)
        if (t) appended.push(toQueueItem(t, pl.items[i].id))
      }
      if (appended.length === 0) return
      const base = st.queue.length
      st.setQueue([...st.queue, ...appended])
      st.setOriginalOrder([...st.originalOrder, ...appended])
      // Guard the stale tail too (lengths always match, but never trust it).
      if (st.shuffleOn) st.setShuffleOrder([...st.shuffleOrder.filter((i) => i < base), ...appended.map((_, j) => base + j)])
      addLog(`live queue append: +${appended.length} from playlist "${pl.name}" (pos kept)`)
    } catch (e) {
      addLog(`live queue append failed: ${e}`)
    }
  }, [addTracksToPlaylist])

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

  // Playlist occurrence highlight (instanceId-aware). Library rows match by
  // track id inside LibraryView (twins have distinct ids).
  const currentQueueKey = currentTrack ? queueKey(currentTrack) : null

  const renderContent = () => {
    switch (activeTab) {
      case 'add':
        return <AddView onPickFolder={handlePickFolder} onPickFiles={handlePickFiles} />
      case 'library':
        return (
          <LibraryView
            tracks={libraryTracks}
            onSelectTrack={handleSelectTrack}
            onPickFolder={handlePickFolder}
            onPickFiles={handlePickFiles}
            onRemoveTracks={handleRemoveTracks}
            onAddToPlaylist={handleAddToPlaylist}
            libraryMembership={hasSameTracks(queue, libraryTracks)}
            currentTrackId={currentTrack?.id ?? null}
            onReorderQueue={reorderQueue}
          />
        )
      case 'playlists':
        return (
          <PlaylistsView
            playlists={playlists}
            onCreatePlaylist={async (name, tracks) => { await createPlaylist(name, tracks ?? []) }}
            onForcePlayPlaylist={forcePlayPlaylist}
            onDeletePlaylist={async (id) => {
              // If currently playing this playlist, clear queue (compare by queueKey occurrences)
              const pl = playlists.find(p => p.id === id)
              const itemKeys = pl ? new Set(pl.items.map((it) => it.id)) : new Set<string>()
              const wasPlaying = pl ? queue.length > 0 && queue.length === pl.items.length && queue.every((t) => itemKeys.has(queueKey(t))) : false
              await deletePlaylist(id)
              if (wasPlaying) {
                // Stop audio too — otherwise the orphaned src keeps sounding with no queue.
                try { await pause() } catch { /* best-effort */ }
                const { setQueue, setOriginalOrder, setCurrentTrackIndex } = usePlayerStore.getState()
                setQueue([])
                setOriginalOrder([])
                setCurrentTrackIndex(0)
              }
            }}
            onRemoveFromPlaylist={async (pid, itemIds) => {
              const pl = await getPlaylist(pid)
              if (!pl) return
              const beforeKeys = new Set(pl.items.map((it) => it.id))
              const wasPlayingThisPlaylist = queue.length > 0 && queue.every((t) => beforeKeys.has(queueKey(t))) && queue.length === pl.items.length
              const s = new Set(itemIds)
              pl.items = pl.items.filter(it => !s.has(it.id))
              pl.items.forEach((it, idx) => { it.order = idx })
              pl.updatedAt = Date.now()
              await savePlaylist(pl)
              await refreshPlaylists()
              // If currently playing this playlist, update queue to new order (instanceId per item)
              if (wasPlayingThisPlaylist) {
                const allTracks = await getAllTracks()
                const map = new Map(allTracks.map(t => [t.id, t] as const))
                const resolved: Track[] = []
                for (const it of pl.items) {
                  const t = map.get(it.trackId)
                  if (t) resolved.push(toQueueItem(t, it.id))
                }
                const { setQueue, setOriginalOrder, setCurrentTrackIndex } = usePlayerStore.getState()
                if (resolved.length === 0) {
                  // Last item removed while playing → stop, don't leave orphan audio.
                  try { await pause() } catch { /* best-effort */ }
                  setQueue([])
                  setOriginalOrder([])
                  setCurrentTrackIndex(0)
                } else {
                  // Policy: if the sounding occurrence survives, keep it playing
                  // seamlessly at its NEW index; if it was removed, migrate to
                  // the next in line (same index holds the successor), or the
                  // previous track when it was the last one.
                  const curKey = currentTrack ? queueKey(currentTrack) : null
                  const newPos = curKey ? findQueueIndexByKey(resolved, curKey) : -1
                  if (newPos !== -1) {
                    setQueue(resolved)
                    setOriginalOrder(resolved)
                    setCurrentTrackIndex(newPos)
                  } else {
                    const migrateIdx = Math.min(currentTrackIndex, resolved.length - 1)
                    const { setQueue: sq, setOriginalOrder: soo } = usePlayerStore.getState()
                    sq(resolved)
                    soo(resolved)
                    goToTrack(migrateIdx >= 0 ? migrateIdx : 0)
                  }
                }
              }
            }}
            currentTrackId={currentTrack?.id ?? null}
            currentQueueKey={currentQueueKey}
            onAddTracksToPlaylist={handleAddTracksToPlaylist}
            onReorderItems={handleReorderPlaylistItems}
          />
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
      trackCount={libraryTracks.length}
      sidebar={
        <Sidebar
          trackCount={libraryTracks.length}
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
    {pendingAddTracks && (
      <AddToPlaylistSheet
        open={!!pendingAddTracks}
        tracks={pendingAddTracks}
        playlists={playlists}
        onClose={handleCloseSheet}
        onAdd={handleAddTracksToPlaylist}
        onCreate={async (name, tracks) => { await createPlaylist(name, tracks) }}
        onAfterAdd={handleAfterAdd}
      />
    )}
    </>
  )
}
