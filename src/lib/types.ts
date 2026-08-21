export type RepeatMode = "off" | "all" | "one";
export type SkipMode = "skip10" | "prevnext" | "both";
export type SessionStyle = "dual" | "audio-only";
/** Who currently owns the iOS audio session. */
export type SessionOwner = "idle" | "track" | "anchor";
/**
 * handoff   — track XOR silent placeholder (default, no seek-bar fight)
 * always-on — both play together (reproduces the snapping seek bar)
 * off       — no placeholder; pause may kill the iOS session
 */
export type AnchorMode = "handoff" | "always-on" | "off";

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
