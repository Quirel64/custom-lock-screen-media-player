import { useMemo, useRef, useState } from "react";
import { usePlaybackEngine } from "../hooks/usePlaybackEngine";
import { useMediaSessionController, type SkipMode } from "../hooks/useMediaSessionController";
import { generateArtwork } from "../lib/artwork";
import { formatTime } from "../lib/format";
import type { AnchorMode, SessionStyle } from "../lib/types";
import EventLog from "./EventLog";
import HandoffStatus from "./HandoffStatus";
import LockScreenPreview from "./LockScreenPreview";
import PlaylistPanel from "./PlaylistPanel";

const MODE_INFO: Record<SkipMode, { label: string; description: string }> = {
  skip10: {
    label: "±10s skip (round arrows)",
    description:
      'Registers seekbackward / seekforward / seekto. This is what produces the round "10" arrows and a working, draggable seek bar (your screenshot #1).',
  },
  prevnext: {
    label: "Prev / Next track (chevrons)",
    description:
      "Registers previoustrack / nexttrack instead. iOS swaps in the plain double-triangle chevrons. Next/prev now actually walk the playlist.",
  },
  both: {
    label: "Both at once (buggy / ambiguous)",
    description:
      "Registers all four handlers simultaneously — the trap the original repo falls into. Lock-screen UI becomes version-dependent.",
  },
};

export default function MediaTestPlayer() {
  const engine = usePlaybackEngine();
  const [mode, setMode] = useState<SkipMode>("skip10");
  const [skipSeconds, setSkipSeconds] = useState(10);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const artworkUrl = useMemo(
    () => generateArtwork(engine.currentTrack?.name ?? "MP"),
    [engine.currentTrack?.name]
  );

  const showSkipButtons = mode === "skip10" || mode === "both";
  const showTrackButtons = mode === "prevnext" || mode === "both";

  useMediaSessionController({
    getMediaEl: engine.getAudio,
    title: engine.currentTrack?.name ?? "",
    artist: "Lock Screen Test Player",
    album: engine.sessionStyle === "dual" ? "Dual audio+video session" : "Audio-only session",
    artworkUrl,
    mode,
    skipSeconds,
    onPlay: () => {
      void engine.play();
    },
    onPause: engine.pause,
    onSeekRelative: engine.seekRelative,
    onSeekAbsolute: engine.seek,
    onPrevTrack: engine.prevTrack,
    onNextTrack: engine.nextTrack,
    log: engine.log,
  });

  const toggleSkipVsTrackMode = () => {
    setMode((prev) => (prev === "prevnext" ? "skip10" : "prevnext"));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* Hidden but ALWAYS-mounted file input. iOS ignores dynamically created ones. */}
      <input
        id="playlist-file-input"
        ref={fileInputRef}
        type="file"
        accept="video/mp4,audio/mp4,audio/mpeg,audio/mp3,audio/wav,audio/aac,audio/x-m4a,video/*,audio/*"
        multiple
        className="sr-only"
        onChange={(e) => {
          engine.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">
              Now playing
            </h2>
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

          <div className="overflow-hidden rounded-xl bg-black">
            <div
              ref={engine.videoContainerRef}
              className={`relative aspect-video w-full bg-black ${
                engine.currentTrack?.mediaType === "video" && engine.sessionStyle === "dual"
                  ? "block"
                  : "hidden"
              }`}
            />
            {!(engine.currentTrack?.mediaType === "video" && engine.sessionStyle === "dual") && (
              <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-slate-800 to-slate-950">
                <span className="text-5xl">{engine.currentTrack ? "🎧" : "🎶"}</span>
                <p className="max-w-[90%] truncate px-4 text-sm text-white/70">
                  {engine.currentTrack?.name ?? "Nothing loaded"}
                </p>
              </div>
            )}
          </div>

          <div className="mt-3 min-h-[2.5rem]">
            <p className="truncate text-base font-semibold text-white">
              {engine.currentTrack?.name ?? "No track selected"}
            </p>
            <p className="text-xs text-white/40">
              {engine.tracks.length === 0
                ? "Add files to the playlist below"
                : `Track ${engine.currentIndex + 1} of ${engine.tracks.length}`}
            </p>
          </div>

          <div className="mt-3">
            <HandoffStatus
              owner={engine.sessionOwner}
              anchorMode={engine.anchorMode}
              isPlaying={engine.isPlaying}
              trackTime={engine.currentTime}
              trackDuration={engine.duration}
              anchorTime={engine.anchorTime}
              anchorDuration={engine.anchorDuration}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {showTrackButtons && (
              <button
                onClick={engine.prevTrack}
                disabled={engine.tracks.length === 0}
                title="Previous track"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                </svg>
              </button>
            )}
            {showSkipButtons && (
              <button
                onClick={() => engine.seekRelative(-skipSeconds)}
                disabled={!engine.currentTrack}
                className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                « {skipSeconds}s
              </button>
            )}

            <button
              onClick={engine.togglePlay}
              disabled={!engine.currentTrack}
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:shadow-none"
            >
              {engine.isPlaying ? (
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
                  <rect x="5" y="3" width="5" height="18" rx="1" />
                  <rect x="14" y="3" width="5" height="18" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-6 w-6 translate-x-0.5" fill="currentColor">
                  <path d="M6 3.5v17a1 1 0 0 0 1.53.85l13.5-8.5a1 1 0 0 0 0-1.7l-13.5-8.5A1 1 0 0 0 6 3.5Z" />
                </svg>
              )}
            </button>

            {showSkipButtons && (
              <button
                onClick={() => engine.seekRelative(skipSeconds)}
                disabled={!engine.currentTrack}
                className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                {skipSeconds}s »
              </button>
            )}
            {showTrackButtons && (
              <button
                onClick={engine.nextTrack}
                disabled={engine.tracks.length === 0}
                title="Next track"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20 disabled:opacity-30"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>
            )}

            <button
              onClick={engine.cycleRepeat}
              title={`Repeat: ${engine.repeatMode}`}
              className={`ml-1 rounded-lg px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide transition ${
                engine.repeatMode === "off"
                  ? "bg-white/5 text-white/40"
                  : "bg-indigo-500/30 text-indigo-200"
              }`}
            >
              {engine.repeatMode === "one" ? "Rep 1" : engine.repeatMode === "all" ? "Rep all" : "Rep off"}
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="w-10 text-right font-mono text-[11px] text-white/50">
              {formatTime(engine.currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={engine.duration || 0}
              step={0.1}
              value={Math.min(engine.currentTime, engine.duration || 0)}
              onChange={(e) => engine.seek(Number(e.target.value))}
              disabled={!engine.currentTrack}
              className="w-full accent-emerald-400 disabled:opacity-40"
            />
            <span className="w-10 font-mono text-[11px] text-white/50">
              {formatTime(engine.duration)}
            </span>
          </div>
        </section>

        <PlaylistPanel
          tracks={engine.tracks}
          currentIndex={engine.currentIndex}
          isPlaying={engine.isPlaying}
          onSelect={engine.goToTrack}
          onRemove={engine.removeTrack}
          onClear={engine.clearPlaylist}
        />

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            Lock-screen behavior
          </h2>

          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Pause-hold strategy</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["handoff", "Handoff (recommended)"],
                    ["always-on", "Always-on (broken seek bar)"],
                    ["off", "No placeholder"],
                  ] as [AnchorMode, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => engine.setAnchorMode(value)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      engine.anchorMode === value
                        ? "bg-amber-500 text-black"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">
                {engine.anchorMode === "handoff"
                  ? "Play = only the track. Pause = track stops, a silent WAV of the SAME length snaps to the same currentTime and plays, rewinding 1s every second so the lock-screen seek bar stays frozen. Resume = placeholder stops, track continues."
                  : engine.anchorMode === "always-on"
                    ? "Both the track and a silent placeholder play at once. This is the current repo behavior — iOS snaps the seek bar between the two durations."
                    : "No silent placeholder. Pause may let iOS kill the audio session so lock-screen play() does nothing."}
              </p>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Video display</p>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["audio-only", "Audio only (lock screen from <audio>)"],
                    ["dual", "Seek-framed <video> (visual only, never plays)"],
                  ] as [SessionStyle, string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => engine.setSessionStyle(value)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      engine.sessionStyle === value
                        ? "bg-emerald-500 text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">
                Video is never the playing element. Playing a &lt;video&gt; is what makes iOS
                treat the session as video and pause it when you lock the phone.
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
                      mode === m ? "bg-indigo-500 text-white" : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    {MODE_INFO[m].label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">{MODE_INFO[mode].description}</p>
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
            title={engine.currentTrack?.name ?? ""}
            subtitle="Lock Screen Test Player"
            currentTime={engine.currentTime}
            duration={engine.duration}
            isPlaying={engine.isPlaying}
            mode={mode}
            skipSeconds={skipSeconds}
            onScrub={engine.seek}
            onSkipBack={() => engine.seekRelative(-skipSeconds)}
            onSkipForward={() => engine.seekRelative(skipSeconds)}
            onTogglePlay={engine.togglePlay}
            onPrev={engine.prevTrack}
            onNext={engine.nextTrack}
          />
          <p className="mt-4 text-center text-xs text-white/40">
            Lock your iPhone or swipe to Control Center while this is playing to see the
            real iOS UI.
          </p>
        </section>

        <section className="h-80">
          <EventLog entries={engine.logs} onClear={engine.clearLogs} />
        </section>
      </div>
    </div>
  );
}
