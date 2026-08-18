import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMediaSessionController, type SkipMode } from "../hooks/useMediaSessionController";
import { createSilentAudioUrl } from "../lib/silentAudio";
import { generateArtwork } from "../lib/artwork";
import { formatTime } from "../lib/format";
import EventLog from "./EventLog";
import LockScreenPreview from "./LockScreenPreview";

type ElementKind = "video" | "audio";

const MODE_INFO: Record<SkipMode, { label: string; description: string }> = {
  skip10: {
    label: "±10s skip (round arrows)",
    description:
      'Registers seekbackward / seekforward / seekto. This is what produces the round "10" arrows and a working, draggable seek bar (your screenshot #1).',
  },
  prevnext: {
    label: "Prev / Next track (chevrons)",
    description:
      "Registers previoustrack / nexttrack instead. iOS swaps in the plain double-triangle chevrons, and the seek bar commonly stops being interactive (your screenshot #2).",
  },
  both: {
    label: "Both at once (buggy / ambiguous)",
    description:
      "Registers all four handlers simultaneously - this is an easy trap to fall into (it's what your current repo does). Behavior becomes inconsistent between iOS versions / web vs installed-PWA.",
  },
};

const ELEMENT_INFO: Record<ElementKind, string> = {
  video:
    'Uses a <video> element as the Media Session "source of truth". iOS is much more likely to draw the interactive seek bar + skip UI for video-backed sessions.',
  audio:
    'Uses an <audio> element only. iOS tends to fall back to a simpler transport UI here (matches the behavior you saw where the seek bar looked present but did nothing).',
};

export default function MediaTestPlayer() {
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string>("");
  const [elementKind, setElementKind] = useState<ElementKind>("video");
  const [mode, setMode] = useState<SkipMode>("skip10");
  const [skipSeconds, setSkipSeconds] = useState(10);
  const [silentAnchorEnabled, setSilentAnchorEnabled] = useState(true);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const silentAnchorRef = useRef<HTMLAudioElement | null>(null);
  const [silentAnchorUrl] = useState(() => createSilentAudioUrl());
  const artworkUrl = useMemo(() => generateArtwork(file?.name ?? "MP"), [file]);

  const log = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-199), `[${time}] ${msg}`]);
  }, []);

  const activeMedia = elementKind === "video" ? videoRef.current : audioRef.current;

  // Handle new file selection.
  const onFileChange = (f: File | null) => {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    setFile(f);
    setFileUrl(f ? URL.createObjectURL(f) : "");
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (f) log(`Loaded file: ${f.name} (${f.type || "unknown type"})`);
  };

  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire native media element events -> React state.
  useEffect(() => {
    const media = activeMedia;
    if (!media) return;

    const onTime = () => setCurrentTime(media.currentTime);
    const onLoaded = () => setDuration(media.duration || 0);
    const onPlay = () => {
      setIsPlaying(true);
      log(`<${elementKind}> play event`);
      if (silentAnchorEnabled && silentAnchorRef.current) {
        silentAnchorRef.current.play().catch(() => {});
      }
    };
    const onPause = () => {
      setIsPlaying(false);
      log(`<${elementKind}> pause event`);
    };
    const onEnded = () => log(`<${elementKind}> ended`);

    media.addEventListener("timeupdate", onTime);
    media.addEventListener("loadedmetadata", onLoaded);
    media.addEventListener("durationchange", onLoaded);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", onEnded);

    return () => {
      media.removeEventListener("timeupdate", onTime);
      media.removeEventListener("loadedmetadata", onLoaded);
      media.removeEventListener("durationchange", onLoaded);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("ended", onEnded);
    };
  }, [activeMedia, elementKind, log, silentAnchorEnabled]);

  // Track page visibility so users can see exactly when backgrounding happens.
  useEffect(() => {
    const onVisibility = () => {
      log(`document.visibilityState -> ${document.visibilityState}`);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [log]);

  const seekAbsolute = useCallback(
    (time: number) => {
      const media = activeMedia;
      if (!media) return;
      const clamped = Math.max(0, Math.min(time, media.duration || time));
      media.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [activeMedia]
  );

  const seekRelative = useCallback(
    (delta: number) => {
      const media = activeMedia;
      if (!media) return;
      seekAbsolute(media.currentTime + delta);
    },
    [activeMedia, seekAbsolute]
  );

  const play = useCallback(() => {
    activeMedia?.play().catch((err) => log(`play() rejected: ${err}`));
  }, [activeMedia, log]);

  const pause = useCallback(() => {
    activeMedia?.pause();
    silentAnchorRef.current?.pause();
  }, [activeMedia]);

  const togglePlay = useCallback(() => {
    if (!activeMedia) return;
    if (activeMedia.paused) play();
    else pause();
  }, [activeMedia, play, pause]);

  useMediaSessionController({
    mediaEl: activeMedia,
    title: file?.name.replace(/\.[^.]+$/, "") ?? "",
    artist: "Lock Screen Test Player",
    album: elementKind === "video" ? "Video session" : "Audio session",
    artworkUrl,
    mode,
    skipSeconds,
    onPlay: play,
    onPause: pause,
    onSeekRelative: seekRelative,
    onSeekAbsolute: seekAbsolute,
    onPrevTrack: () => log("onPrevTrack fired (no playlist in this tester - would load previous track)"),
    onNextTrack: () => log("onNextTrack fired (no playlist in this tester - would load next track)"),
    log,
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
      {/* Left column: controls */}
      <div className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            1. Load a file
          </h2>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/20 bg-black/20 px-4 py-8 text-center transition hover:border-emerald-400/60 hover:bg-black/30">
            <span className="text-3xl">🎬</span>
            <span className="text-sm text-white/70">
              {file ? file.name : "Click to choose an .mp4 (video or audio-only) file"}
            </span>
            <span className="text-xs text-white/40">MP4 recommended · also accepts other audio/video types</span>
            <input
              type="file"
              accept="video/mp4,audio/mp4,video/*,audio/*"
              className="hidden"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
          </label>
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            2. Preview &amp; playback
          </h2>
          <div className="overflow-hidden rounded-xl bg-black">
            {elementKind === "video" ? (
              <video
                ref={videoRef}
                src={fileUrl || undefined}
                playsInline
                className="aspect-video w-full bg-black"
                controls={false}
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900">
                <audio ref={audioRef} src={fileUrl || undefined} className="hidden" />
                <span className="text-5xl">🔊</span>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={togglePlay}
              disabled={!file}
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
            <button
              onClick={() => seekRelative(-skipSeconds)}
              disabled={!file}
              className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
            >
              « {skipSeconds}s
            </button>
            <button
              onClick={() => seekRelative(skipSeconds)}
              disabled={!file}
              className="rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/20 disabled:opacity-30"
            >
              {skipSeconds}s »
            </button>
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
            onChange={(e) => seekAbsolute(Number(e.target.value))}
            disabled={!file}
            className="mt-3 w-full accent-emerald-400 disabled:opacity-40"
          />

          {silentAnchorEnabled && (
            <audio ref={silentAnchorRef} src={silentAnchorUrl} loop className="hidden" />
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            3. Lock-screen behavior settings
          </h2>

          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium text-white/60">Media element used for the session</p>
              <div className="flex gap-2">
                {(["video", "audio"] as ElementKind[]).map((kind) => (
                  <button
                    key={kind}
                    onClick={() => setElementKind(kind)}
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                      elementKind === kind
                        ? "bg-emerald-500 text-white"
                        : "bg-white/10 text-white/70 hover:bg-white/20"
                    }`}
                  >
                    &lt;{kind}&gt;
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-white/40">{ELEMENT_INFO[elementKind]}</p>
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

            <label className="flex items-center justify-between rounded-lg bg-black/20 px-3 py-2">
              <span className="text-xs text-white/60">
                Silent audio anchor (helps <em>video</em> keep playing in background)
              </span>
              <input
                type="checkbox"
                checked={silentAnchorEnabled}
                onChange={(e) => setSilentAnchorEnabled(e.target.checked)}
                className="h-4 w-4 accent-emerald-400"
              />
            </label>
          </div>
        </section>
      </div>

      {/* Right column: lock screen preview + log */}
      <div className="space-y-5">
        <section className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/5 to-transparent p-5 backdrop-blur">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
            Lock screen preview (mock)
          </h2>
          <LockScreenPreview
            title={file?.name.replace(/\.[^.]+$/, "") ?? ""}
            subtitle="Lock Screen Test Player"
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            mode={mode}
            skipSeconds={skipSeconds}
            onScrub={seekAbsolute}
            onSkipBack={() => seekRelative(-skipSeconds)}
            onSkipForward={() => seekRelative(skipSeconds)}
            onTogglePlay={togglePlay}
            onPrev={() => log("Preview: prev tapped")}
            onNext={() => log("Preview: next tapped")}
          />
          <p className="mt-4 text-center text-xs text-white/40">
            Now lock your iPhone (or swipe to Control Center) while this is playing to see
            the <span className="text-white/70">real</span> iOS UI and compare it to this
            mock.
          </p>
        </section>

        <section className="h-72">
          <EventLog entries={logs} onClear={() => setLogs([])} />
        </section>
      </div>
    </div>
  );
}
