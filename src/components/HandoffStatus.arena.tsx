import { formatTime } from "../lib/format.arena";
import type { AnchorMode, SessionOwner } from "../lib/types.arena";

interface Props {
  owner: SessionOwner;
  anchorMode: AnchorMode;
  isPlaying: boolean;
  trackTime: number;
  trackDuration: number;
  anchorTime: number;
  anchorDuration: number;
}

const OWNER_LABEL: Record<SessionOwner, { text: string; className: string }> = {
  idle: { text: "Idle — nothing holding the session", className: "bg-white/10 text-white/60" },
  track: {
    text: "Track owns session (placeholder paused)",
    className: "bg-emerald-500/20 text-emerald-200",
  },
  anchor: {
    text: "Placeholder hold (tap native pause again to resume)",
    className: "bg-amber-500/20 text-amber-200",
  },
};

export default function HandoffStatus({
  owner,
  anchorMode,
  isPlaying,
  trackTime,
  trackDuration,
  anchorTime,
  anchorDuration,
}: Props) {
  const chip = OWNER_LABEL[owner];
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-white/60">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}>
          {chip.text}
        </span>
        <span className="text-white/30">mode {anchorMode}</span>
        <span className="text-white/30">{isPlaying ? "playing" : "paused"}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <span>track</span>
        <span className="text-white/80">
          {formatTime(trackTime)} / {formatTime(trackDuration)}
        </span>
        <span>placeholder</span>
        <span className="text-white/80">
          {formatTime(anchorTime)} / {formatTime(anchorDuration)}
        </span>
      </div>
      {anchorMode === "handoff" && owner === "anchor" && (
        <p className="mt-2 text-[10px] text-amber-200/70">
          same permanent audio element; only its source changed to the placeholder.
        </p>
      )}
    </div>
  );
}
