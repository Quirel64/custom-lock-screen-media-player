import { useEffect, useRef } from "react";
import type { SkipMode } from "../lib/types";

export type { SkipMode };

interface Options {
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
}

/**
 * Registers Media Session action handlers. Which ones we register is what
 * decides the iOS lock-screen chrome:
 *
 *   skip10   -> seekbackward / seekforward  => round ±10 buttons
 *   prevnext -> previoustrack / nexttrack   => << >> chevrons
 *   both     -> everything (ambiguous / the bug in the original repo)
 *
 * Handlers always call through a ref so they never go stale, and they always
 * talk to the persistent <audio> via getMediaEl() — never a render-time snapshot.
 */
export function useMediaSessionController(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: options.title || "Untitled",
      artist: options.artist || "Local file",
      album: options.album || "Lock Screen Test",
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
    const log = optionsRef.current.log;

    const safeSet = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action on this OS */
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
