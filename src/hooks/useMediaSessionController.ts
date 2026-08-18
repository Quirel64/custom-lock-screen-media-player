import { useEffect, useRef } from "react";

export type SkipMode = "skip10" | "prevnext" | "both";

interface Options {
  mediaEl: HTMLMediaElement | null;
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
}

/**
 * Wires the Media Session API to a media element.
 *
 * The `mode` prop is the important part for testing: it controls exactly which
 * action handlers are registered, which is what iOS uses to decide whether the
 * lock screen shows round "±10s" skip arrows or plain "prev/next track" chevrons.
 *
 *  - "skip10"   -> registers seekbackward/seekforward (+ seekOffset). iOS shows round
 *                  arrows with the number of seconds inside them.
 *  - "prevnext" -> registers previoustrack/nexttrack instead. iOS shows plain double
 *                  triangle chevrons, and (per Apple's behavior) the seek bar becomes
 *                  informational-looking / less reliably scrubbable on some iOS versions.
 *  - "both"     -> registers everything at once. This mirrors an easy-to-fall-into bug
 *                  where both sets of handlers are registered simultaneously - the
 *                  resulting lock screen UI is inconsistent/version-dependent, which is
 *                  usually where "it works sometimes" bugs come from.
 */
export function useMediaSessionController(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Setup metadata whenever track info changes.
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

  // Register action handlers whenever mode changes.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const log = optionsRef.current.log;

    const safeSet = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Some actions (e.g. skipad) aren't supported everywhere - ignore.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.mode, options.skipSeconds]);

  // Keep playbackState + position state in sync.
  useEffect(() => {
    const media = options.mediaEl;
    if (!media || !("mediaSession" in navigator)) return;

    const updatePositionState = () => {
      if (!Number.isFinite(media.duration) || media.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: media.duration,
          playbackRate: media.playbackRate || 1,
          position: Math.min(media.currentTime, media.duration),
        });
      } catch {
        /* iOS can throw if called too early */
      }
    };

    const updatePlaybackState = () => {
      navigator.mediaSession.playbackState = media.paused ? "paused" : "playing";
    };

    let lastUpdate = 0;
    const onTimeUpdate = () => {
      const now = performance.now();
      if (now - lastUpdate > 1000) {
        lastUpdate = now;
        updatePositionState();
      }
    };

    media.addEventListener("loadedmetadata", updatePositionState);
    media.addEventListener("durationchange", updatePositionState);
    media.addEventListener("play", updatePositionState);
    media.addEventListener("play", updatePlaybackState);
    media.addEventListener("pause", updatePlaybackState);
    media.addEventListener("seeked", updatePositionState);
    media.addEventListener("timeupdate", onTimeUpdate);

    updatePositionState();
    updatePlaybackState();

    return () => {
      media.removeEventListener("loadedmetadata", updatePositionState);
      media.removeEventListener("durationchange", updatePositionState);
      media.removeEventListener("play", updatePositionState);
      media.removeEventListener("play", updatePlaybackState);
      media.removeEventListener("pause", updatePlaybackState);
      media.removeEventListener("seeked", updatePositionState);
      media.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [options.mediaEl]);
}
