/**
 * iOS Safari exposes `navigator.audioSession`. Setting type to "playback"
 * tells the OS this page is a real media player (not a webpage with incidental
 * sound), which is required for:
 *   - audio to keep playing after the screen locks / the PWA is backgrounded
 *   - play() to succeed again after pause, including from the lock screen
 *     (which is NOT a user gesture)
 */
export function setPlaybackAudioSession(): void {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) {
      nav.audioSession.type = "playback";
    }
  } catch {
    /* older Safari */
  }
}

export function detectMediaType(file: File): "audio" | "video" {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mov", "m4v", "webm", "mkv", "avi"].includes(ext)) return "video";
  return "audio";
}

export function trackTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
