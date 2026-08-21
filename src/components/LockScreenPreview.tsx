import type { SkipMode } from "../hooks/useMediaSessionController";
import { formatTime } from "../lib/format";

interface Props {
  title: string;
  subtitle: string;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  mode: SkipMode;
  skipSeconds: number;
  onScrub: (time: number) => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
}

function Skip10Icon({ direction }: { direction: "back" | "forward" }) {
  const flip = direction === "back" ? "scale-x-[-1]" : "";
  return (
    <div className="relative flex h-9 w-9 items-center justify-center">
      <svg viewBox="0 0 44 44" className={`h-9 w-9 text-white ${flip}`} fill="none">
        <path
          d="M22 6a16 16 0 1 1-11.3 4.7"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path d="M11 4.5 10.6 11.2 17.1 12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={`absolute text-[10px] font-bold text-white ${flip}`}>10</span>
    </div>
  );
}

function ChevronIcon({ direction }: { direction: "back" | "forward" }) {
  const flip = direction === "back" ? "scale-x-[-1]" : "";
  return (
    <svg viewBox="0 0 32 24" className={`h-7 w-9 text-white ${flip}`} fill="currentColor">
      <path d="M0 12 12 2v20L0 12Z" />
      <path d="M14 12 26 2v20L14 12Z" />
    </svg>
  );
}

function PlayPauseIcon({ isPlaying }: { isPlaying: boolean }) {
  if (isPlaying) {
    return (
      <svg viewBox="0 0 24 24" className="h-9 w-9 text-white" fill="currentColor">
        <rect x="5" y="3" width="5" height="18" rx="1.2" />
        <rect x="14" y="3" width="5" height="18" rx="1.2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-9 w-9 text-white" fill="currentColor">
      <path d="M6 3.5v17a1 1 0 0 0 1.53.85l13.5-8.5a1 1 0 0 0 0-1.7l-13.5-8.5A1 1 0 0 0 6 3.5Z" />
    </svg>
  );
}

export default function LockScreenPreview({
  title,
  subtitle,
  currentTime,
  duration,
  isPlaying,
  mode,
  skipSeconds,
  onScrub,
  onSkipBack,
  onSkipForward,
  onTogglePlay,
  onPrev,
  onNext,
}: Props) {
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const remaining = Math.max(0, duration - currentTime);

  return (
    <div className="mx-auto w-full max-w-md overflow-hidden rounded-[28px] border border-white/15 bg-gradient-to-br from-emerald-950/70 via-emerald-900/50 to-black/60 p-5 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-2xl shadow-inner">
          🎧
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-white">{title || "No file loaded"}</p>
          <p className="truncate text-[13px] text-white/60">{subtitle || "Choose a file to begin"}</p>
        </div>
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-white/40" fill="currentColor">
          <rect x="1" y="9" width="2.4" height="6" rx="1" />
          <rect x="6" y="6" width="2.4" height="12" rx="1" />
          <rect x="11" y="3" width="2.4" height="18" rx="1" />
          <rect x="16" y="7" width="2.4" height="10" rx="1" />
          <rect x="21" y="10" width="2.4" height="4" rx="1" />
        </svg>
      </div>

      <div className="mt-4">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => onScrub(Number(e.target.value))}
          disabled={mode === "prevnext"}
          className="w-full accent-white disabled:opacity-70"
          style={{
            background: `linear-gradient(to right, rgba(255,255,255,0.85) ${pct}%, rgba(255,255,255,0.25) ${pct}%)`,
          }}
        />
        <div className="mt-1 flex justify-between text-[11px] font-medium text-white/60">
          <span>{formatTime(currentTime)}</span>
          <span>-{formatTime(remaining)}</span>
        </div>
        {mode === "prevnext" && (
          <p className="mt-1 text-center text-[10px] text-amber-300/80">
            seek bar intentionally disabled in this mode - mirrors iOS behavior with
            previoustrack/nexttrack handlers
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between px-2">
        <button onClick={onPrev} className={mode === "skip10" ? "pointer-events-none opacity-0" : ""} aria-hidden={mode === "skip10"}>
          {mode !== "skip10" && <ChevronIcon direction="back" />}
        </button>
        <button onClick={onSkipBack} className={mode === "prevnext" ? "pointer-events-none opacity-0" : ""} aria-hidden={mode === "prevnext"}>
          {mode !== "prevnext" && <Skip10Icon direction="back" />}
        </button>

        <button
          onClick={onTogglePlay}
          className="flex h-11 w-11 items-center justify-center rounded-full transition active:scale-90"
        >
          <PlayPauseIcon isPlaying={isPlaying} />
        </button>

        <button onClick={onSkipForward} className={mode === "prevnext" ? "pointer-events-none opacity-0" : ""} aria-hidden={mode === "prevnext"}>
          {mode !== "prevnext" && <Skip10Icon direction="forward" />}
        </button>
        <button onClick={onNext} className={mode === "skip10" ? "pointer-events-none opacity-0" : ""} aria-hidden={mode === "skip10"}>
          {mode !== "skip10" && <ChevronIcon direction="forward" />}
        </button>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 px-1 text-white/40">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M3 10v4h4l5 5V5L7 10H3Z" />
        </svg>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M12 2l6 6-3 3-1.5-1.5L11 12l3 3 1.5-1.5 3 3-6 6-2-2 3-3-4-4-4 4-2-2 3-3-4-4 2-2 4 4 4-4-3-3 2-2Z" />
        </svg>
      </div>

      <p className="mt-3 text-center text-[10px] uppercase tracking-wide text-white/30">
        In-app preview only - actual lock screen skin comes from iOS, this just mirrors
        which buttons {`your chosen handlers ("${mode}") would ask iOS to draw`}
        {mode === "skip10" ? ` (±${skipSeconds}s)` : ""}
      </p>
    </div>
  );
}
