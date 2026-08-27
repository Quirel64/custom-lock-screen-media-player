import { useMemo, useState } from "react";
import { useMediaSessionController, type SkipMode } from "../hooks/useMediaSessionController";
import { usePlaybackEngine, type ElementMode, type SessionOwner } from "../hooks/usePlaybackEngine";
import { useSingleElementEngine } from "../hooks/useSingleElementEngine";
import { generateArtwork } from "../lib/artwork";
import { formatTime } from "../lib/format";
import EventLog from "./EventLog";
import LockScreenPreview from "./LockScreenPreview";

const MODE_INFO: Record<SkipMode, { label: string; description: string }> = {
  skip10: {
    label: "±10s skip (round arrows)",
    description:
      'Registers seekbackward / seekforward / seekto. This is what produces the round "10" arrows and a working, draggable seek bar (your screenshot #1).',
  },
  prevnext: {
    label: "Prev / Next track (chevrons)",
    description:
      "Registers previoustrack / nexttrack instead. iOS swaps in the plain double-triangle chevrons. Load 2+ files so next/prev has something real to switch to.",
  },
  both: {
    label: "Both at once (buggy / ambiguous)",
    description:
      "Registers all four handlers simultaneously - this is an easy trap to fall into (it's what your current repo does). Behavior becomes inconsistent between iOS versions / web vs installed-PWA.",
  },
};

const ELEMENT_INFO: Record<ElementMode, string> = {
  dual:
    "Hidden <audio> is the source of truth. Muted <video> provides the visual surface AND the interactive lock-screen seek bar. Recommended (matches your repo).",
  "video-only":
    "A single <video> element is the source of truth. Good lock-screen seek UI, but iOS is more aggressive about killing video sessions when backgrounded.",
  "audio-only":
    "A single <audio> element only. Background keep-alive is reliable, but iOS often draws a simpler lock-screen UI where the seek bar looks present but doesn't scrub.",
};

const OWNER_LABEL: Record<SessionOwner | "frozen", { text: string; color: string }> = {
  track: { text: "TRACK owns session", color: "bg-emerald-500/20 text-emerald-300 ring-emerald-400/40" },
  anchor: { text: "ANCHOR owns session (paused keep-alive)", color: "bg-amber-500/20 text-amber-300 ring-amber-400/40" },
  frozen: { text: "FROZEN single-element (plan 1)", color: "bg-sky-500/20 text-sky-300 ring-sky-400/40" },
  none: { text: "No session owner", color: "bg-white/10 text-white/40 ring-white/10" },
} as Record<string, { text: string; color: string }>;

export default function MediaTestPlayer() {
  const [elementMode, setElementMode] = useState<ElementMode>("dual");
  const [mode, setMode] = useState<SkipMode>("skip10");
  const [skipSeconds, setSkipSeconds] = useState(10);
  const [handoffEnabled, setHandoffEnabled] = useState(true);
  const [useSingleElement, setUseSingleElement] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const log = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-199), `[${time}] ${msg}`]);
  };

  const anchorEngine = usePlaybackEngine({
    elementMode,
    handoffEnabled,
    log,
  });
  const singleEngine = useSingleElementEngine({
    elementMode,
    log,
  });
  const engine = useSingleElement ? singleEngine : anchorEngine;

  const {
    tracks,
    currentIndex,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    sessionOwner,
    videoContainerRef,
    mediaRef,
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
    getMediaEl: () => mediaRef.current,
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
        `${msg} | owner=${d.owner} trackPaused=${String(d.trackPaused)} anchorPaused=${String(
          d.anchorPaused
        )} track=${d.trackTime?.toFixed(1) ?? "?"} anchor=${
          d.anchorTime?.toFixed(1) ?? "?"
        } frozen=${d.frozenPosition.toFixed(1)}`
      );
    },
    mediaEpoch: `${currentIndex}-${currentTrack?.id ?? "none"}-${elementMode}`,
  });

  const showSkipButtons = mode === "skip10" || mode === "both";
  const showTrackButtons = mode === "prevnext" || mode === "both";
  const owner = OWNER_LABEL[sessionOwner];

  const toggleSkipVsTrackMode = () => {
    setMode((prev) => (prev === "prevnext" ? "skip10" : "prevnext"));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="space-y-5">
        {/* Playlist */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              1. Playlist
            </h2>
            {tracks.length > 0 && (
              <button
                onClick={clearPlaylist}
                className="rounded-md px-2 py-1 text-xs text-white/40 transition hover:bg-white/10 hover:text-white"
              >
                Clear all
              </button>
            )}
          </div>

          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/20 bg-black/20 px-4 py-6 text-center transition hover:border-emerald-400/60 hover:bg-black/30">
            <span className="text-3xl">🎬</span>
            <span className="text-sm text-white/70">
              {tracks.length > 0
                ? `${tracks.length} track(s) — tap to add more`
                : "Tap to add .mp4 / audio / video files"}
            </span>
            <span className="text-xs text-white/40">
              Select multiple files so lock-screen Next / Previous actually switches tracks
            </span>
            <input
              type="file"
              accept="video/mp4,audio/mp4,video/*,audio/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>

          {tracks.length > 0 && (
            <ul className="mt-3 max-h-52 space-y-1 overflow-y-auto">
              {tracks.map((t, i) => (
                <li
                  key={t.id}
                  className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs transition ${
                    i === currentIndex
                      ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40"
                      : "bg-black/20 text-white/60 hover:bg-black/30"
                  }`}
                >
                  <button
                    onClick={() => goToTrack(i)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={t.file.name}
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-[10px] opacity-60">
                      {i === currentIndex ? "▶" : i + 1}
                    </span>
                    <span className="truncate">{t.name}</span>
                    <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/40">
                      {t.mediaType}
                    </span>
                  </button>
                  <button
                    onClick={() => removeTrack(i)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-white/40 hover:bg-white/10 hover:text-white"
                    aria-label="Remove track"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tracks.length === 1 && mode !== "skip10" && (
            <p className="mt-2 text-[11px] text-amber-300/80">
              Only 1 track loaded — Next/Previous will restart it. Add a second file to
              actually switch tracks from the lock screen.
            </p>
          )}
        </section>

        {/* Player */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              2. Playback
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void armSession("manual-button")}
                className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/20 hover:text-white active:scale-95"
                title="Warms the hidden audio anchor from a user gesture. Useful if standalone PWA controls start dead after reopening."
              >
                Arm iOS session
              </button>
              <button
                onClick={() => void recoverSession()}
                className="rounded-full bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 ring-1 ring-amber-400/30 transition hover:bg-amber-500/30 active:scale-95"
                title="Rebuilds the hidden media elements without force-closing the PWA."
              >
                Recover session
              </button>
              <button
                onClick={toggleSkipVsTrackMode}
                className="flex items-center gap-2 rounded-full bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-500/30 transition hover:bg-indigo-400 active:scale-95"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                  <path d="M7 7h11l-2.5-2.5L17 3l5 5-5 5-1.5-1.5L18 9H7a3 3 0 1 0 0 6h4v2H7a5 5 0 0 1 0-10Z" />
                </svg>
                {mode === "prevnext" ? "Switch to ±10s skip" : "Switch to Prev / Next track"}
              </button>
            </div>
          </div>

          {/* Session owner badge — the key diagnostic for the handoff */}
          <div
            className={`mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${owner.color}`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                sessionOwner === "track"
                  ? "bg-emerald-400 animate-pulse"
                  : sessionOwner === "anchor"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-white/30"
              }`}
            />
            {owner.text}
          </div>

          <div
            ref={videoContainerRef}
            className="relative aspect-video w-full overflow-hidden rounded-xl bg-black"
          >
            {!currentTrack && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-white/30">
                No track loaded
              </div>
            )}
            {currentTrack && currentTrack.mediaType === "audio" && elementMode !== "video-only" && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 to-slate-900">
                <span className="text-5xl">🔊</span>
                <span className="max-w-[80%] truncate text-xs text-white/50">{currentTrack.name}</span>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {showTrackButtons && (
              <button
                onClick={prevTrack}
                disabled={tracks.length === 0}
                title="Previous track"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
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
                title="Next track"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
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

        {/* Settings */}
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            3. Lock-screen behavior settings
          </h2>

          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Playback architecture</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["dual", "Dual (audio + muted video)"],
                    ["video-only", "Video only"],
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
              <p className="mb-2 text-xs font-medium text-white/60">Lock screen button mode</p>
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

            <div className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2">
              <label htmlFor="skipSeconds" className="text-xs text-white/60">
                Skip interval (only applies to "±skip" mode)
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

            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg bg-black/20 px-3 py-3">
              <span className="text-xs leading-relaxed text-white/60">
                <span className="block font-medium text-white/80">
                  Exclusive anchor handoff {useSingleElement ? "(off — single-element test)" : ""}
                </span>
                When playing: only the track runs. On pause: a silent WAV whose{" "}
                <em>duration matches the track</em> takes over at the frozen position and
                pins there so the iOS session stays alive without snapping the seek bar.
                On resume: anchor stops, track continues.
              </span>
              <input
                type="checkbox"
                checked={handoffEnabled}
                disabled={useSingleElement}
                onChange={(e) => setHandoffEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-400 disabled:opacity-30"
              />
            </label>
            <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg bg-sky-500/10 px-3 py-3 ring-1 ring-sky-400/30">
              <span className="text-xs leading-relaxed text-white/60">
                <span className="block font-medium text-sky-200">Plan 1: Single-element freeze (test)</span>
                On pause: keep SAME element playing at 0.001 vol + 0.0001 rate, pin
                <code className="text-sky-300"> currentTime = frozenPos</code> via
                <code className="text-sky-300"> timeupdate</code>. No second element, no handoff.
                On play: restore vol/rate. Tests if iOS keeps session without an anchor.
              </span>
              <input
                type="checkbox"
                checked={useSingleElement}
                onChange={(e) => setUseSingleElement(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
              />
            </label>
          </div>
        </section>
      </div>

      {/* Right column */}
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
              Watch the owner badge above flip between{" "}
              <span className="text-emerald-300">TRACK</span> and{" "}
              <span className="text-amber-300">ANCHOR</span> as you pause/resume. On a
              real iPhone the seek bar should stay put (no snap) because only one element
              is ever playing.
            </p>
            <p>
              Test path: play → lock phone → pause on lock screen → wait 10s+ → press play
              again. The event log should show{" "}
              <code className="text-white/60">handoff → ANCHOR</code> then{" "}
              <code className="text-white/60">handoff → TRACK</code> +{" "}
              <code className="text-white/60">play() succeeded</code>.
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
