export type RepeatMode = "off" | "all" | "one";
export type SkipMode = "skip10" | "prevnext" | "both";
export type SessionStyle = "dual" | "audio-only";
/** Who currently owns the iOS audio session. */
export type SessionOwner = "idle" | "track" | "anchor";
/**
 * handoff — one permanent audio element swaps between track and placeholder
 * off     — no placeholder; a long pause may kill the iOS PWA audio session
 */
export type AnchorMode = "handoff" | "off";

export interface PlaylistTrack {
  id: string;
  file: File;
  url: string;
  name: string;
  mediaType: "audio" | "video";
  size: number;
}

export function createTrack(file: File): PlaylistTrack {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    url: URL.createObjectURL(file),
    name: file.name.replace(/\.[^.]+$/, ""),
    mediaType: file.type.startsWith("video/")
      ? "video"
      : file.type.startsWith("audio/")
        ? "audio"
        : ["mp4", "mov", "m4v", "webm", "mkv"].includes(
            file.name.split(".").pop()?.toLowerCase() ?? ""
          )
          ? "video"
          : "audio",
    size: file.size,
  };
}
