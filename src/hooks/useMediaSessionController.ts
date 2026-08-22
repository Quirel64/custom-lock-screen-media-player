import { useEffect, useRef } from "react";

export type SkipMode = "skip10" | "prevnext" | "both";

interface Options {
  /** Live getter for the current source-of-truth media element. */
  getMediaEl: () => HTMLMediaElement | null;
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  mode: SkipMode;
  skipSeconds: number;
  onPlay: () => void;
  onPause: () => void;
  onSeekRelative: (deltaSeconds: number) => void;
  onSeekAbsolute: (time: number) => void;
  onPrevTrack: () => void;
  onNextTrack: () => void;
  log: (msg: string) => void;
  /** Optional: re-bind position-state updates when the underlying element changes. */
  mediaEpoch?: number | string;
}

/**
 * Wires the Media Session API.
 *
 * The `mode` prop controls which handlers iOS uses to decide the lock-screen skin:
 *  - "skip10"   -> seekbackward/seekforward  => round ±Ns arrows + interactive seek bar
 *  - "prevnext" -> previoustrack/nexttrack   => plain chevrons, seek bar often non-interactive
 *  - "both"     -> all four (ambiguous / version-dependent)
 *
 * Handlers are registered once and call into stable refs, so they keep working even
 * after the page has been backgrounded and the React tree has re-rendered.
 */
export function useMediaSessionController(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Metadata whenever track info changes.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: options.title || "Untitled",
      artist: options.artist || "Local file",
      album: options.album || "iOS Lock Screen Test",
      artwork: options.artworkUrl
        ? [
            { src: options.artworkUrl, sizes: "512x512", type: "image/png" },
            { src: options.artworkUrl, sizes: "192x192", type: "image/png" },
          ]
        : [],
    });
  }, [options.title, options.artist, options.album, options.artworkUrl]);

  // Action handlers - depend only on mode / skipSeconds. Callbacks are read from the ref.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const log = (msg: string) => optionsRef.current.log(msg);

    const safeSet = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* some actions unsupported */
      }
    };

    safeSet("play", () => {
      log("mediaSession: play");
      optionsRef.current.onPlay();
    });
    safeSet("pause", () => {
      log("mediaSession: pause");
      optionsRef.current.onPause();
    });
    safeSet("seekto", (details) => {
      if (details.seekTime != null) {
        log(`mediaSession: seekto ${details.seekTime.toFixed(1)}s`);
        optionsRef.current.onSeekAbsolute(details.seekTime);
      }
    });

    const registerSkip = () => {
      safeSet("seekbackward", (details) => {
        const offset = details.seekOffset ?? optionsRef.current.skipSeconds;
        log(`mediaSession: seekbackward -${offset}s`);
        optionsRef.current.onSeekRelative(-offset);
      });
      safeSet("seekforward", (details) => {
        const offset = details.seekOffset ?? optionsRef.current.skipSeconds;
        log(`mediaSession: seekforward +${offset}s`);
        optionsRef.current.onSeekRelative(offset);
      });
    };
    const unregisterSkip = () => {
      safeSet("seekbackward", null);
      safeSet("seekforward", null);
    };

    const registerPrevNext = () => {
      safeSet("previoustrack", () => {
        log("mediaSession: previoustrack");
        optionsRef.current.onPrevTrack();
      });
      safeSet("nexttrack", () => {
        log("mediaSession: nexttrack");
        optionsRef.current.onNextTrack();
      });
    };
    const unregisterPrevNext = () => {
      safeSet("previoustrack", null);
      safeSet("nexttrack", null);
    };

    if (options.mode === "skip10") {
      registerSkip();
      unregisterPrevNext();
    } else if (options.mode === "prevnext") {
      unregisterSkip();
      registerPrevNext();
    } else {
      // both
      registerSkip();
      registerPrevNext();
    }

    log(`mediaSession: mode set to "${options.mode}"`);

    return () => {
      safeSet("play", null);
      safeSet("pause", null);
      safeSet("seekto", null);
      unregisterSkip();
      unregisterPrevNext();
    };
  }, [options.mode, options.skipSeconds]);

  // Keep playbackState + position state in sync with the live element.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    let disposed = false;
    let attached: HTMLMediaElement | null = null;
    let lastUpdate = 0;

    const updatePositionState = (media: HTMLMediaElement) => {
      if (!Number.isFinite(media.duration) || media.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: media.duration,
          playbackRate: media.playbackRate || 1,
          position: Math.min(media.currentTime, media.duration),
        });
      } catch {
        /* ignore */
      }
    };

    const updatePlaybackState = (media: HTMLMediaElement) => {
      navigator.mediaSession.playbackState = media.paused ? "paused" : "playing";
    };

    const onTimeUpdate = () => {
      if (!attached) return;
      const now = performance.now();
      if (now - lastUpdate > 1000) {
        lastUpdate = now;
        updatePositionState(attached);
      }
    };

    const detach = () => {
      if (!attached) return;
      attached.removeEventListener("loadedmetadata", onMeta);
      attached.removeEventListener("durationchange", onMeta);
      attached.removeEventListener("play", onPlay);
      attached.removeEventListener("pause", onPause);
      attached.removeEventListener("seeked", onMeta);
      attached.removeEventListener("timeupdate", onTimeUpdate);
      attached = null;
    };

    const onMeta = () => {
      if (attached) updatePositionState(attached);
    };
    const onPlay = () => {
      if (attached) {
        updatePlaybackState(attached);
        updatePositionState(attached);
      }
    };
    const onPause = () => {
      if (attached) updatePlaybackState(attached);
    };

    const attach = (media: HTMLMediaElement) => {
      detach();
      attached = media;
      media.addEventListener("loadedmetadata", onMeta);
      media.addEventListener("durationchange", onMeta);
      media.addEventListener("play", onPlay);
      media.addEventListener("pause", onPause);
      media.addEventListener("seeked", onMeta);
      media.addEventListener("timeupdate", onTimeUpdate);
      updatePositionState(media);
      updatePlaybackState(media);
    };

    // Poll for the live element because it is created/destroyed imperatively.
    const poll = () => {
      if (disposed) return;
      const el = optionsRef.current.getMediaEl();
      if (el && el !== attached) attach(el);
      if (!el && attached) detach();
      timer = window.setTimeout(poll, 400);
    };
    let timer = window.setTimeout(poll, 0);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      detach();
    };
  }, [options.mediaEpoch, options.mode]);
}
