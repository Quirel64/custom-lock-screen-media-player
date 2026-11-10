import { useEffect, useState } from 'react'
import { getLogs, subscribeLogs, clearLogs, addLog } from '../../lib/logger'
import { usePlayerStore } from '../../stores/playerStore'
import { groupTracks, describeGroups } from '../../lib/group'
import { getStorageEstimate, getTruthfulStorageReport } from '../../lib/idb'
import { getProbeDuringPlayback, setProbeDuringPlayback, clearThumbnailFailureMarks } from '../../lib/thumbnail'
import { isVideoPausedMode, setVideoPausedMode, isLockResilientToggle, setLockResilientToggle, isLockReviveOnHidden, setLockReviveOnHidden, isVideoDelayedStart, setVideoDelayedStart, getLockReviveDelay, setLockReviveDelay, isMinimalHandlers, setMinimalHandlers, isEchoAwareToggle, setEchoAwareToggle, isLockWarmCycle, setLockWarmCycle, getWarmCycleDelay, setWarmCycleDelay } from '../../lib/mediaFlags'

export function EventLog() {
  const [entries, setEntries] = useState<string[]>(() => getLogs())
  const queue = usePlayerStore((s) => s.queue)
  const [probePlay, setProbePlay] = useState(() => getProbeDuringPlayback())
  const [videoPaused, setVideoPaused] = useState(() => isVideoPausedMode())
  const [resilient, setResilient] = useState(() => isLockResilientToggle())
  const [revive, setRevive] = useState(() => isLockReviveOnHidden())
  const [delayedStart, setDelayedStart] = useState(() => isVideoDelayedStart())
  const [reviveDelay, setReviveDelay] = useState(() => getLockReviveDelay())
  const [minimalApplies, setMinimalApplies] = useState(() => isMinimalHandlers())
  const [echoAware, setEchoAware] = useState(() => isEchoAwareToggle())
  const [warmCycle, setWarmCycle] = useState(() => isLockWarmCycle())
  const [warmDelay, setWarmDelay] = useState(() => getWarmCycleDelay())

  useEffect(() => subscribeLogs(setEntries), [])

  const toggleProbePlay = () => {
    const next = !probePlay
    setProbePlay(next)
    setProbeDuringPlayback(next)
  }

  const toggleVideoPaused = () => {
    const next = !videoPaused
    setVideoPaused(next)
    setVideoPausedMode(next)
    if (next) {
      // The session may already have a PLAYING muted video — stop it now so
      // the experiment is testable without switching tracks (every engine
      // path that would restart it is gated on the flag anyway).
      document.querySelectorAll('video').forEach((v) => { try { v.pause() } catch { /* ignore */ } })
      addLog('video paused mode: paused any live video element')
    }
  }

  const toggleResilient = () => {
    const next = !resilient
    setResilient(next)
    setLockResilientToggle(next)
  }

  const toggleRevive = () => {
    const next = !revive
    setRevive(next)
    setLockReviveOnHidden(next)
  }

  const toggleDelayedStart = () => {
    const next = !delayedStart
    setDelayedStart(next)
    setVideoDelayedStart(next)
  }

  const cycleReviveDelay = () => {
    const steps = [150, 300, 600]
    const next = steps[(steps.indexOf(reviveDelay) + 1) % steps.length]
    setReviveDelay(next)
    setLockReviveDelay(next)
  }

  const toggleMinimalApplies = () => {
    const next = !minimalApplies
    setMinimalApplies(next)
    setMinimalHandlers(next)
  }

  const toggleEchoAware = () => {
    const next = !echoAware
    setEchoAware(next)
    setEchoAwareToggle(next)
  }

  const toggleWarmCycle = () => {
    const next = !warmCycle
    setWarmCycle(next)
    setLockWarmCycle(next)
  }

  const cycleWarmDelay = () => {
    const steps = [200, 450, 700]
    const next = steps[(steps.indexOf(warmDelay) + 1) % steps.length]
    setWarmDelay(next)
    setWarmCycleDelay(next)
  }

  const resetThumbMarks = () => {
    void clearThumbnailFailureMarks()
  }

  const runGroupPreview = () => {
    if (queue.length === 0) { addLog('group preview: queue empty'); return }
    const res = groupTracks(queue, { minGroupSize: 2 })
    addLog(`=== GROUP PREVIEW (${queue.length} tracks) ===`)
    for (const line of describeGroups(res).split('\n')) addLog(line)
    if (res.loose.length > 0) addLog(`Tip: loose tracks stay as single items; folder toggle will keep queue flat`)
  }

  const runStorageCheck = async () => {
    // estimate() under-reports on iOS (shows ~0.6MB for a real 1.1GB library),
    // so report metadata-byte sum (matches Safari Settings webdata) alongside it.
    try {
      const rep = await getTruthfulStorageReport()
      const realMB = (rep.metadataBytes / (1024 * 1024)).toFixed(1)
      const thumbKB = (rep.thumbBytes / 1024).toFixed(0)
      const estMB = rep.estimateUsage != null ? (rep.estimateUsage / (1024 * 1024)).toFixed(2) : '?'
      const quotaMB = rep.estimateQuota != null ? (rep.estimateQuota / (1024 * 1024)).toFixed(0) : '?'
      addLog(`storage real: ${realMB}MB across ${rep.trackCount} tracks / ${rep.blobCount} blobs; thumbs ${rep.thumbCount} (~${thumbKB}KB) (estimate()=${estMB}MB of ${quotaMB}MB — iOS under-counts, trust the real figure)`)
    } catch (e) {
      const est = await getStorageEstimate()
      if (est) {
        const usageMB = (est.usage / (1024 * 1024)).toFixed(2)
        const quotaMB = (est.quota / (1024 * 1024)).toFixed(0)
        addLog(`storage estimate: usage=${usageMB}MB quota=${quotaMB}MB`)
      } else {
        addLog(`storage check failed: ${e}`)
      }
    }
    try { await (window as any).debugTrackFiles?.() } catch {}
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h3 className="text-sm font-semibold text-white">Event Log</h3>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={toggleProbePlay}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${probePlay ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Probe video thumbnails while audio plays (seekless frame 0 only). Off by default to protect the lock-screen timeline."
          >
            Probe play: {probePlay ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={toggleVideoPaused}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${videoPaused ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: video tracks stay paused + seek-framed (no muted playing timeline). Applies on next video track load/seek."
          >
            Video paused: {videoPaused ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={toggleResilient}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${resilient ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: OFF = lock center presses are literal play/pause, extra pause never auto-resumes. Default ON (inverted-icon workaround)."
          >
            Resilient toggle: {resilient ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={toggleRevive}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${revive ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: on hidden, flip lock mode to the other set and restore after the tuned delay — a mode CHANGE rebuilds the lock UI (same-set re-applies don't). For greyed/touchless lock controls."
          >
            Lock revive: {revive ? 'ON' : 'OFF'} ({reviveDelay}ms)
          </button>
          <button
            onClick={cycleReviveDelay}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
            title="Tune the gap between the revive flip and its restore (cycles 150/300/600ms). If greyed controls slip through, try longer."
          >
            Revive delay
          </button>
          <button
            onClick={toggleMinimalApplies}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${minimalApplies ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: skip identical same-set handler re-applies at track change (boot/mode-toggle/play-start/hidden-flip still apply). Test whether fewer applications changes lock behavior."
          >
            Minimal applies: {minimalApplies ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={toggleEchoAware}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${echoAware ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: with resilient toggle ON, a pause press within 4s of an external native pause (interruption) is ignored as an echo instead of resuming. Play presses always resume. Fixes the interruption ping-pong without losing single-press toggling."
          >
            Echo-aware: {echoAware ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={toggleWarmCycle}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${warmCycle ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: on every visible→hidden, pause the playing track natively then resume ~700ms later — mimics the autoplay warm-up that makes the lock UI come up fully correct (icons, touch routing, seek bar)."
          >
            Warm cycle: {warmCycle ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={cycleWarmDelay}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700"
            title="Warm-cycle gap between the synthetic native pause and the resume (700ms proven; try shorter gaps to reduce the audible pause — too short and iOS may not register the pair)."
          >
            Warm delay
          </button>
          <button
            onClick={toggleDelayedStart}
            className={`rounded-md px-2.5 py-1 text-xs font-medium ${delayedStart ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            title="Experiment: video stays framed+paused for 12s so the session establishes on audio alone, then starts playing in-app. Needs 'Video paused' OFF."
          >
            Video delayed: {delayedStart ? 'ON' : 'OFF'}
          </button>
          <button
            onClick={resetThumbMarks}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
            title="Re-probe files that were marked 'no usable frame' (use after tuning seek constants)"
          >
            Reset dark thumbs
          </button>
          <button
            onClick={runGroupPreview}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            title="Preview auto-group (folder + common words)"
          >
            Test Grouping
          </button>
          <button
            onClick={runStorageCheck}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
            title="Check storage estimate and track file list"
          >
            Check Storage
          </button>
          <button
            onClick={clearLogs}
            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
          >
            Clear
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed selectable">
        {entries.length === 0 ? (
          <p className="text-slate-600">No events yet — play, pause, or lock the phone to generate logs. Tap "Test Grouping" to preview auto-album grouping.</p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="whitespace-pre-wrap break-words text-slate-300">
              {e}
            </div>
          ))
        )}
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
        Tip: keep this tab open, then lock your phone. After resume, come back here — logs persist until clear. Storage debug: <span className="text-slate-400">await getStorageEstimate()</span> and <span className="text-slate-400">await debugTrackFiles()</span> available in console (PWA homescreen has no console — use this log).
      </p>
    </div>
  )
}
