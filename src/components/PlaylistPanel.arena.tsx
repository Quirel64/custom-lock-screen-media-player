import { formatBytes } from "../lib/audioSession.arena";
import type { PlaylistTrack } from "../lib/types.arena";

interface Props {
  tracks: PlaylistTrack[];
  currentIndex: number;
  isPlaying: boolean;
  onSelect: (index: number) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}

export default function PlaylistPanel({
  tracks,
  currentIndex,
  isPlaying,
  onSelect,
  onRemove,
  onClear,
}: Props) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Playlist</h2>
          <p className="text-xs text-white/40">
            {tracks.length === 0
              ? "Empty — add files to build a queue"
              : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex gap-2">
          {tracks.length > 0 && (
            <button
              onClick={onClear}
              className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/50 transition hover:bg-white/10 hover:text-white"
            >
              Clear
            </button>
          )}
          <label
            htmlFor="playlist-file-input"
            className="cursor-pointer rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-emerald-500/20 transition hover:bg-emerald-400"
          >
            + Add files
          </label>
        </div>
      </div>

      {tracks.length === 0 ? (
        <label
          htmlFor="playlist-file-input"
          className="flex cursor-pointer flex-col items-center justify-center gap-2 px-4 py-10 text-center"
        >
          <span className="text-4xl">🎵</span>
          <p className="text-sm font-medium text-white/80">No tracks yet</p>
          <p className="max-w-xs text-xs text-white/40">
            Tap to add MP4 / audio files. On iPhone, add them one at a time — iOS
            usually only lets you pick a single file per tap. Keep tapping Add to
            build a real queue.
          </p>
        </label>
      ) : (
        <ul className="max-h-[50vh] divide-y divide-white/5 overflow-y-auto">
          {tracks.map((track, index) => {
            const active = index === currentIndex;
            return (
              <li
                key={track.id}
                className={`flex items-center gap-3 px-3 py-3 transition ${
                  active ? "bg-emerald-500/15" : "hover:bg-white/5"
                }`}
              >
                <button
                  onClick={() => onSelect(index)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${
                      active ? "bg-emerald-500 text-white" : "bg-white/10 text-white/50"
                    }`}
                  >
                    {active && isPlaying ? "▶" : index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-sm font-medium ${
                        active ? "text-emerald-200" : "text-white/90"
                      }`}
                    >
                      {track.name}
                    </span>
                    <span className="block truncate text-[11px] text-white/40">
                      {track.mediaType === "video" ? "🎬 video" : "🎧 audio"} ·{" "}
                      {formatBytes(track.size)}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => onRemove(track.id)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-white/30 hover:bg-white/10 hover:text-white"
                  aria-label={`Remove ${track.name}`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
