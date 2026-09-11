import { useEffect, useRef } from "react";

export type SkipMode = "skip10" | "prevnext" | "both";

interface Options {
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
  // compat with older call sites that passed these – ignored here because
  // positionState is owned by the freeze engine (see comment above)
  getMediaEl?: () => HTMLMediaElement | null;
  mediaEpoch?: number | string;
}

/**
 * Registers MediaSession *action handlers and metadata only*.
 *
 * Position state (setPositionState / playbackState) is owned exclusively by the
 * playback engine. If this hook also published position from the live element's
 * currentTime, it would fight the freeze engine: while "paused" the element is
 * still playing, so we'd leak playbackRate:1 + drifted time to iOS — that's the
 * lock-screen seek-bar snap.
 */
export function useMediaSessionController(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

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

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const log = (msg: string) => optionsRef.current.log(msg);

    const safeSet = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action */
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
  }, [options.mode, options.skipSeconds]);
}
