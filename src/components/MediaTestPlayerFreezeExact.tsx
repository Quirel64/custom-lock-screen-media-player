import { useMemo, useState } from "react";
import { useMediaSessionController, type SkipMode } from "../hooks/useMediaSessionController";
import {
  useFreezeEngine,
  type ElementMode,
  type SessionOwner,
  type VideoSyncMode,
} from "../hooks/useFreezeEngine.exact";
import { generateArtwork } from "../lib/artwork";
import { formatTime } from "../lib/format";
import EventLog from "./EventLog";
import LockScreenPreview from "./LockScreenPreview";
import PlaylistPanel from "./PlaylistPanel.exact";
import VideoSurface from "./VideoSurface.exact";

const MODE_INFO: Record<SkipMode, { label: string; description: string }> = {
  skip10: {
    label: "±10s skip (round arrows)",
    description:
      "Registers seekbackward / seekforward / seekto. Round 10 arrows + working seek bar.",
  },
  prevnext: {
    label: "Prev / Next track (chevrons)",
    description:
      "Registers previoustrack / nexttrack. Load 2+ files so next/prev actually switches tracks.",
  },
  both: {
    label: "Both at once (ambiguous)",
    description:
      "Registers all four handlers. iOS behaviour is version-dependent — useful as a regression test.",
  },
};

const ELEMENT_INFO: Record<ElementMode, string> = {
  dual: "Hidden <audio> is source of truth. Muted <video> gives the interactive lock-screen seek UI.",
  "video-only": "Video element is also attached for lock-screen skin. Audio still drives time.",
  "audio-only": "Audio only. Background keep-alive is reliable; lock-screen seek bar is often weaker.",
};

const OWNER_LABEL: Record<SessionOwner, { text: string; color: string }> = {
  track: {
    text: "TRACK playing (session alive)",
    color: "bg-emerald-500/20 text-emerald-300 ring-emerald-400/40",
  },
  frozen: {
    text: "FROZEN (paused to you, still playing silently)",
    color: "bg-sky-500/20 text-sky-300 ring-sky-400/40",
  },
  none: {
    text: "No session",
    color: "bg-white/10 text-white/40 ring-white/10",
  },
};

export default function MediaTestPlayerFreezeExact() {
  const [elementMode, setElementMode] = useState<ElementMode>("dual");
  const [mode, setMode] = useState<SkipMode>("skip10");
  const [skipSeconds, setSkipSeconds] = useState(10);
  const [videoSyncMode, setVideoSyncMode] = useState<VideoSyncMode>("nudge");
  const [logs, setLogs] = useState<string[]>([]);

  const log = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-199), `[${time}] ${msg}`]);
  };

  const engine = useFreezeEngine({ elementMode, videoSyncMode, log });
  const {
    tracks,
    currentIndex,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    sessionOwner,
    videoContainerRef,
    isFrozen,
    videoSyncStats,
    getDiagnostics,
    addFiles,
    removeTrack,
    clearPlaylist,
    armSession,
    recoverSession,
    play,
    remotePauseOrResume,
    togglePlay,
    seek,
    seekRelative,
    nextTrack,
    prevTrack,
    goToTrack,
  } = engine;

  const artworkUrl = useMemo(
    () => generateArtwork(currentTrack?.name ?? "MP"),
    [currentTrack?.name]
  );

  useMediaSessionController({
    title: currentTrack?.name ?? "",
    artist: "Lock Screen Test Player",
    album: currentTrack?.mediaType === "video" ? "Video track" : "Audio track",
    artworkUrl,
    mode,
    skipSeconds,
    onPlay: () => {
      void play();
    },
    onPause: () => {
      remotePauseOrResume();
    },
    onSeekRelative: seekRelative,
    onSeekAbsolute: seek,
    onPrevTrack: prevTrack,
    onNextTrack: nextTrack,
    log: (msg) => {
      const d = getDiagnostics();
      log(
        `${msg} | owner=${d.owner} paused=${String(d.trackPaused)} t=${
          d.trackTime?.toFixed(1) ?? "?"
        } frozen=${d.frozenPosition.toFixed(1)} rate=${d.rate ?? "?"} vol=${
          d.volume?.toFixed(3) ?? "?"
        }`
      );
    },
  });

  const showSkipButtons = mode === "skip10" || mode === "both";
  const showTrackButtons = mode === "prevnext" || mode === "both";
  const owner = OWNER_LABEL[sessionOwner];

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="space-y-5">
        <PlaylistPanel
          tracks={tracks}
          currentIndex={currentIndex}
          isPlaying={isPlaying}
          onSelect={goToTrack}
          onRemove={removeTrack}
          onClear={clearPlaylist}
          onAdd={addFiles}
        />

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              2. Playback
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void armSession()}
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/20 hover:text-white"
              >
                Arm iOS session
              </button>
              <button
                onClick={() => void recoverSession()}
                className="rounded-full bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/30 transition hover:bg-amber-500/30"
              >
                Recover
              </button>
              <button
                onClick={() => setMode((m) => (m === "prevnext" ? "skip10" : "prevnext"))}
                className="rounded-full bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-500/30 transition hover:bg-indigo-400"
              >
                {mode === "prevnext" ? "Switch to ±10s skip" : "Switch to Prev / Next"}
              </button>
            </div>
          </div>

          <div
            className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${owner.color}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                sessionOwner === "track"
                  ? "bg-emerald-400 animate-pulse"
                  : sessionOwner === "frozen"
                    ? "bg-sky-400 animate-pulse"
                    : "bg-white/30"
              }`}
            />
            {owner.text}
          </div>

          <VideoSurface
            videoContainerRef={videoContainerRef}
            track={currentTrack}
            isPlaying={isPlaying}
            isFrozen={isFrozen}
            currentTime={currentTime}
            duration={duration}
            skipSeconds={skipSeconds}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onSeekRelative={seekRelative}
            log={log}
          />

          {currentTrack?.mediaType === "video" && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px]">
              <span className="text-white/40">A/V sync</span>
              <span
                className={
                  videoSyncStats && Math.abs(videoSyncStats.drift) > 0.3
                    ? "text-amber-300"
                    : "text-emerald-300"
                }
              >
                drift {videoSyncStats ? `${videoSyncStats.drift >= 0 ? "+" : ""}${videoSyncStats.drift.toFixed(2)}s` : "—"}
              </span>
              <span className="text-white/70">
                rate {videoSyncStats ? videoSyncStats.rate.toFixed(3) : "—"}
              </span>
              <span className={videoSyncStats && videoSyncStats.seeks > 5 ? "text-rose-300" : "text-white/70"}>
                seeks {videoSyncStats?.seeks ?? 0}
              </span>
              <span className="text-white/50">nudges {videoSyncStats?.nudges ?? 0}</span>
              <span className="text-white/50">lead {videoSyncStats ? videoSyncStats.seekLead.toFixed(2) : "—"}</span>
              <span className="ml-auto truncate text-white/40">{videoSyncStats?.lastAction ?? ""}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {showTrackButtons && (
              <button
                onClick={prevTrack}
                disabled={tracks.length === 0}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
                title="Previous track"
              >
                <svg viewBox="0 0 32 24" className="h-4 w-5 scale-x-[-1]" fill="currentColor">
                  <path d="M0 12 12 2v20L0 12Z" />
                  <path d="M14 12 26 2v20L14 12Z" />
                </svg>
              </button>
            )}
            {showSkipButtons && (
              <button
                onClick={() => seekRelative(-skipSeconds)}
                disabled={!currentTrack}
                className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                « {skipSeconds}s
              </button>
            )}

            <button
              onClick={togglePlay}
              disabled={!currentTrack}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:shadow-none"
            >
              {isPlaying ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <rect x="5" y="3" width="5" height="18" rx="1" />
                  <rect x="14" y="3" width="5" height="18" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5 translate-x-0.5" fill="currentColor">
                  <path d="M6 3.5v17a1 1 0 0 0 1.53.85l13.5-8.5a1 1 0 0 0 0-1.7l-13.5-8.5A1 1 0 0 0 6 3.5Z" />
                </svg>
              )}
            </button>

            {showSkipButtons && (
              <button
                onClick={() => seekRelative(skipSeconds)}
                disabled={!currentTrack}
                className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                {skipSeconds}s »
              </button>
            )}
            {showTrackButtons && (
              <button
                onClick={nextTrack}
                disabled={tracks.length === 0}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
                title="Next track"
              >
                <svg viewBox="0 0 32 24" className="h-4 w-5" fill="currentColor">
                  <path d="M0 12 12 2v20L0 12Z" />
                  <path d="M14 12 26 2v20L14 12Z" />
                </svg>
              </button>
            )}
            <div className="flex-1" />
            <span className="font-mono text-xs text-white/50">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={!currentTrack}
            className="mt-3 w-full accent-emerald-400 disabled:opacity-40"
          />
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            3. Lock-screen settings
          </h2>
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Playback architecture</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["dual", "Dual (audio + muted video)"],
                    ["video-only", "Video attached"],
                    ["audio-only", "Audio only"],
                  ] as [ElementMode, string][]
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    onClick={() => setElementMode(kind)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      elementMode === kind
                        ? "bg-emerald-500 text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">
                {ELEMENT_INFO[elementMode]}
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Lock screen buttons</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(MODE_INFO) as SkipMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      mode === m
                        ? "bg-indigo-500 text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {MODE_INFO[m].label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">
                {MODE_INFO[mode].description}
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Video A/V sync strategy</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["nudge", "Rate nudge (smooth)"],
                    ["legacy-seek", "Seek on drift >0.3s (old — stutters)"],
                  ] as [VideoSyncMode, string][]
                ).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => setVideoSyncMode(m)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      videoSyncMode === m
                        ? m === "nudge"
                          ? "bg-emerald-500 text-white"
                          : "bg-rose-500 text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">
                {videoSyncMode === "nudge"
                  ? "Small drift is corrected by speeding the muted video up/down ≤8%. A seek only happens when drift > 1.2s, never while another seek is in flight, with a cooldown so the decode can land. Watch “seeks” stay flat."
                  : "Reproduces the original loop: every timeupdate with drift > 0.3s does video.currentTime = audio.currentTime. On iOS the seek lands ~200–400ms late, drift is > 0.3 again, seek again. Watch “seeks” climb and the picture hitch."}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2">
              <label htmlFor="skipSeconds" className="text-xs text-white/60">
                Skip interval
              </label>
              <select
                id="skipSeconds"
                value={skipSeconds}
                onChange={(e) => setSkipSeconds(Number(e.target.value))}
                className="rounded-md bg-white/10 px-2 py-1 text-xs text-white"
              >
                {[10, 15, 30].map((s) => (
                  <option key={s} value={s} className="text-black">
                    {s}s
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>
      </div>

      <div className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            Lock screen preview (mock)
          </h2>
          <LockScreenPreview
            title={currentTrack?.name ?? ""}
            subtitle={
              tracks.length > 1
                ? `Track ${currentIndex + 1} of ${tracks.length}`
                : "Lock Screen Test Player"
            }
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            mode={mode}
            skipSeconds={skipSeconds}
            onScrub={seek}
            onSkipBack={() => seekRelative(-skipSeconds)}
            onSkipForward={() => seekRelative(skipSeconds)}
            onTogglePlay={togglePlay}
            onPrev={prevTrack}
            onNext={nextTrack}
          />
          <div className="mt-4 space-y-2 text-center text-xs text-white/40">
            <p>
              This build uses <span className="text-sky-300">single-element freeze</span>{" "}
              (the PWA-working approach). Pause does not pause the element — it freezes
              position and publishes <code className="text-white/60">playbackRate: 0</code>{" "}
              so iOS stops interpolating the lock-screen bar.
            </p>
            <p>
              Test: play → lock → pause → wait 20s → resume. The bar should not jump
              forward by those 20 seconds. Add a second file and use Prev/Next to switch
              tracks without reloading the current one.
            </p>
          </div>
        </section>
        <section className="h-80">
          <EventLog entries={logs} onClear={() => setLogs([])} />
        </section>
      </div>
    </div>
  );
}
