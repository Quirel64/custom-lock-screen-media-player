import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { formatTime } from "../lib/format";
import type { Track } from "../hooks/useFreezeEngine.exact";

interface Props {
  videoContainerRef: RefObject<HTMLDivElement | null>;
  track: Track | null;
  isPlaying: boolean;
  isFrozen: boolean;
  currentTime: number;
  duration: number;
  skipSeconds: number;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onSeekRelative: (d: number) => void;
  log: (msg: string) => void;
}

const isStandalone = () =>
  (navigator as unknown as { standalone?: boolean }).standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;

/**
 * In-app video player surface that does NOT interfere with the audio session.
 *
 * Rules baked in:
 *  - The <video> is owned by the engine (muted, playsInline, remote playback off).
 *    This component never calls video.play()/pause() directly — it only calls
 *    engine actions, so there is exactly one place that decides what plays.
 *  - Fullscreen is CSS pseudo-fullscreen. We deliberately do NOT call
 *    video.webkitEnterFullscreen(): on iPhone that launches the native player,
 *    which takes the session with the video's (muted) audio → silence + the
 *    hidden <audio> often gets paused. On iPad, real Fullscreen API exists on
 *    the container, so we use it when available.
 *  - The ref container is a dedicated empty div; overlays are siblings.
 */
export default function VideoSurface({
  videoContainerRef,
  track,
  isPlaying,
  isFrozen,
  currentTime,
  duration,
  skipSeconds,
  onTogglePlay,
  onSeek,
  onSeekRelative,
  log,
}: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [flash, setFlash] = useState<null | { side: "left" | "right"; id: number }>(null);
  const hideTimer = useRef<number>(0);
  const lastTap = useRef<{ t: number; x: number }>({ t: 0, x: 0 });
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  const isVideo = track?.mediaType === "video";

  const bumpControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    if (isPlaying) {
      hideTimer.current = window.setTimeout(() => setControlsVisible(false), 2800);
    }
  }, [isPlaying]);

  useEffect(() => {
    bumpControls();
    return () => window.clearTimeout(hideTimer.current);
  }, [isPlaying, bumpControls]);

  // Escape / back gesture exits pseudo-fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // Track real Fullscreen API changes (iPad / desktop).
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const enterFullscreen = async () => {
    const el = wrapperRef.current;
    setFullscreen(true);
    bumpControls();
    // iPad / desktop: real fullscreen on the *container*, never the <video>.
    if (el && typeof el.requestFullscreen === "function") {
      try {
        await el.requestFullscreen();
        log("fullscreen: container.requestFullscreen()");
      } catch (e) {
        log(`fullscreen: requestFullscreen rejected (${String(e)}) → CSS overlay`);
      }
    } else {
      log("fullscreen: CSS overlay (no Fullscreen API on this device)");
    }
    // Landscape lock only works in real fullscreen; harmless when it throws.
    try {
      const so = screen.orientation as unknown as { lock?: (o: string) => Promise<void> };
      await so.lock?.("landscape");
    } catch {
      /* expected on iPhone */
    }
  };

  const exitFullscreen = async () => {
    setFullscreen(false);
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }
    try {
      const so = screen.orientation as unknown as { unlock?: () => void };
      so.unlock?.();
    } catch {
      /* ignore */
    }
  };

  const handleTap = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = performance.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const isDouble = now - lastTap.current.t < 300 && Math.abs(x - lastTap.current.x) < 80;
    lastTap.current = { t: now, x };

    if (isDouble) {
      const side = x < rect.width / 2 ? "left" : "right";
      onSeekRelative(side === "left" ? -skipSeconds : skipSeconds);
      setFlash({ side, id: now });
      window.setTimeout(() => setFlash((f) => (f && f.id === now ? null : f)), 500);
      bumpControls();
      return;
    }
    // Single tap toggles controls only; play/pause is the explicit button.
    setControlsVisible((v) => !v);
    if (!controlsVisible) bumpControls();
  };

  const pct = duration > 0 ? ((scrubbing ? scrubValue : currentTime) / duration) * 100 : 0;

  const shell = fullscreen
    ? "fixed inset-0 z-[100] bg-black"
    : "relative aspect-video w-full overflow-hidden rounded-xl bg-black";

  return (
    <div
      ref={wrapperRef}
      className={shell}
      style={
        fullscreen
          ? {
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
              paddingLeft: "env(safe-area-inset-left)",
              paddingRight: "env(safe-area-inset-right)",
            }
          : undefined
      }
    >
      {/* Engine-owned <video> mounts here. Keep this div childless in React. */}
      <div
        ref={videoContainerRef}
        className={`absolute inset-0 ${isVideo ? "" : "hidden"}`}
      />

      {!track && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-white/30">
          No track loaded
        </div>
      )}
      {track && !isVideo && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-slate-800 to-slate-900">
          <span className="text-5xl">🔊</span>
          <span className="max-w-[80%] truncate text-xs text-white/50">{track.name}</span>
        </div>
      )}

      {/* Tap layer */}
      {track && (
        <div className="absolute inset-0 select-none" onPointerUp={handleTap} />
      )}

      {/* Double-tap flash */}
      {flash && (
        <div
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/15 px-4 py-2 text-xs font-semibold text-white backdrop-blur ${
            flash.side === "left" ? "left-6" : "right-6"
          }`}
        >
          {flash.side === "left" ? `« ${skipSeconds}s` : `${skipSeconds}s »`}
        </div>
      )}

      {/* Frozen badge — visible reminder that "paused" ≠ element paused */}
      {isFrozen && isVideo && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-sky-500/25 px-2 py-0.5 text-[10px] font-semibold text-sky-200 ring-1 ring-sky-400/40">
          frozen · audio session alive
        </div>
      )}

      {/* Controls overlay */}
      {track && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-3 pt-10 transition-opacity duration-200 ${
            controlsVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="pointer-events-auto flex items-center gap-3">
            <button
              onClick={() => {
                onTogglePlay();
                bumpControls();
              }}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-lg active:scale-95"
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

            <span className="w-12 text-right font-mono text-[11px] text-white/80">
              {formatTime(scrubbing ? scrubValue : currentTime)}
            </span>

            <div className="relative flex-1">
              <div className="h-1 w-full rounded-full bg-white/25">
                <div className="h-1 rounded-full bg-white" style={{ width: `${pct}%` }} />
              </div>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={scrubbing ? scrubValue : Math.min(currentTime, duration || 0)}
                onPointerDown={() => {
                  setScrubbing(true);
                  setScrubValue(currentTime);
                  window.clearTimeout(hideTimer.current);
                }}
                onChange={(e) => setScrubValue(Number(e.target.value))}
                onPointerUp={(e) => {
                  const v = Number((e.target as HTMLInputElement).value);
                  setScrubbing(false);
                  onSeek(v);
                  bumpControls();
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Seek"
              />
            </div>

            <span className="w-12 font-mono text-[11px] text-white/60">
              -{formatTime(Math.max(0, duration - (scrubbing ? scrubValue : currentTime)))}
            </span>

            {isVideo && (
              <button
                onClick={() => (fullscreen ? void exitFullscreen() : void enterFullscreen())}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur active:scale-95"
                title={fullscreen ? "Exit fullscreen" : "Fullscreen (CSS overlay, safe for audio session)"}
              >
                {fullscreen ? (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                  </svg>
                )}
              </button>
            )}
          </div>

          {isVideo && (
            <p className="text-[10px] text-white/35">
              Double-tap sides to skip ±{skipSeconds}s · fullscreen is a CSS overlay
              {isStandalone() ? " · PiP unavailable in standalone PWA" : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
