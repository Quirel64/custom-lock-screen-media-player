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

    const installHandlers = () => {
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

      const currentMode = optionsRef.current.mode;
      if (currentMode === "skip10") {
        registerSkip();
        unregisterPrevNext();
      } else if (currentMode === "prevnext") {
        unregisterSkip();
        registerPrevNext();
      } else {
        registerSkip();
        registerPrevNext();
      }
    };

    installHandlers();

    // Standalone iOS occasionally starts with no Now Playing session even
    // though handlers were installed at mount. Reinstalling on the permanent
    // element's first/each playing event reliably attaches them to the active
    // native media session without recreating the element.
    const media = optionsRef.current.getMediaEl();
    const onPlaying = () => {
      installHandlers();
      log("mediaSession: handlers refreshed after native playing");
    };
    const onPageShow = () => installHandlers();
    media?.addEventListener("playing", onPlaying);
    window.addEventListener("pageshow", onPageShow);

    log(`mediaSession: mode set to "${options.mode}"`);

    return () => {
      media?.removeEventListener("playing", onPlaying);
      window.removeEventListener("pageshow", onPageShow);
      safeSet("play", null);
      safeSet("pause", null);
      safeSet("seekto", null);
      unregisterSkip();
      unregisterPrevNext();
    };
  }, [options.mode, options.skipSeconds]);
}


/*/
11:15:48] environment: browser tab; permanent element ready
[11:15:48] permanent audio element ready (same-element handoff)
[11:15:48] lockscreen handlers applied: skip10
[11:15:48] flags: video-paused-mode=0 lock-resilient-toggle=0 lock-revive-on-hidden=1 (revive 150ms) video-delayed-start=0 minimal-handlers=0 echo-aware-toggle=0 lock-warm-cycle=0 (warm 200ms) thumb-probe-play=0
[11:15:48] arena port: playbackState=no-paused echoGate=ON videoTeardown=OFF audioSession=playback presses=engine-aware parkedNav=ON windowsFreezeHold=ON
[11:15:48] lockscreen handlers applied: prevnext
[11:15:48] reconcile ok: 51 tracks, library in sync
[11:15:48] lockscreen handlers: first-load apply (refresh attach, one-shot)
[11:15:48] lockscreen handlers applied: prevnext
[11:15:48] thumb: hydrated 46 persisted thumbnails
[11:15:49] building same-element placeholder 52.1s @ 8000 Hz (~814 KB)
[11:15:49] boot probe: track 1/51 staged (element untouched)
[11:15:50] pre-publish track playing dur=52.1 pos=0.00 rate=1
[11:15:51] native playing (track, same element)
[11:15:51] first-play one-shot handler apply (refresh attach)
[11:15:51] lockscreen handlers applied: prevnext
[11:15:51] post-publish track playing dur=52.1 pos=0.03 rate=1 state=playing
[11:15:51] track source active on permanent element @ 0.03s +video playing owner=track
[11:15:52] lockscreen handlers applied: skip10
[11:15:52] lock revive: mode flip prevnext → skip10 → restoring…
[11:15:52] visibility -> hidden owner=track kind=track pending=null lock=playing
[11:15:52] hidden track refresh playing pos=0.81
[11:15:52] lockscreen handlers applied: prevnext
[11:15:53] lockscreen handlers applied: prevnext
[11:15:53] load [2/51] Luigi's Casino - New Super Mario Bros. autoplay=true (wasPlaying=true)
[11:15:53] pre-publish track playing dur=52.1 pos=0.00 rate=1
[11:15:53] preload cached [3] A Hat in Time OST [Seal 
[11:15:53] swap coalesced [3] (settle in flight)
[11:15:53] lockscreen handlers applied: prevnext
[11:15:53] swap coalesced [4] (settle in flight)
[11:15:53] lockscreen handlers applied: prevnext
[11:15:54] swap coalesced [5] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] native playing (track, same element)
[11:15:54] post-publish track playing dur=123.2 pos=0.00 rate=1 state=playing
[11:15:54] track source active on permanent element @ 0.00s +video paused owner=track
[11:15:54] catch-up paced +281ms (pipeline floor)
[11:15:54] swap paced +270ms [6]
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] swap paced +165ms [7]
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] swap paced +46ms [8]
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] track change 1417 -> d575: will reset pos to 0
[11:15:54] swap coalesced [8] (settle in flight)
[11:15:54] swap coalesced [8] (settle in flight)
[11:15:54] swap coalesced [8] (settle in flight)
[11:15:54] track change 1417 -> d575: fresh load
[11:15:54] load [8/51] A Hat in Time OST [Seal the Deal] - Collapsing Time Rift autoplay=true (wasPlaying=true)
[11:15:54] pre-publish track playing dur=123.2 pos=0.00 rate=1
[11:15:54] swap coalesced [9] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] preload cached [9] _Library of Ruina_ theme
[11:15:54] preload cached [7] Curtain Call - (Finii's 
[11:15:54] swap coalesced [10] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] swap coalesced [11] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] swap coalesced [12] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:54] track play() rejected: Error: track play() timed out after 500ms
[11:15:54] track source swap play() failed: Error: track play() timed out after 500ms
[11:15:54] swap coalesced [13] (settle in flight)
[11:15:54] lockscreen handlers applied: prevnext
[11:15:55] track source swap retry skipped (superseded)
[11:15:55] catch-up paced +96ms (pipeline floor)
[11:15:55] swap paced +41ms [14]
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] native playing (track, same element)
[11:15:55] track change d575 -> 0ef6: will reset pos to 0
[11:15:55] swap coalesced [14] (settle in flight)
[11:15:55] video not ready in time — framed paused instead
[11:15:55] track change d575 -> 0ef6: fresh load
[11:15:55] load [14/51] ブルーアーカイブ Blue Archive OST 26. Lemonade Diary autoplay=true (wasPlaying=true)
[11:15:55] pre-publish track playing dur=430.4 pos=0.00 rate=1
[11:15:55] preload cached [15] DECO_27 - Rabbit Hole_ _
[11:15:55] preload cached [13] P5 OST 09 Beneath the Ma
[11:15:55] swap coalesced [15] (settle in flight)
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] swap coalesced [16] (settle in flight)
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] swap coalesced [17] (settle in flight)
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] swap coalesced [18] (settle in flight)
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] video not ready in time — framed paused instead
[11:15:55] track play() rejected: Error: track play() timed out after 500ms
[11:15:55] track source swap play() failed: Error: track play() timed out after 500ms
[11:15:55] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] native playing (track, same element)
[11:15:55] track source swap retry skipped (superseded)
[11:15:55] catch-up paced +111ms (pipeline floor)
[11:15:55] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:55] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:55] lockscreen handlers applied: prevnext
[11:15:55] video not ready in time — framed paused instead
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] building same-element placeholder 154.0s @ 8000 Hz (~2407 KB)
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] video not ready in time — framed paused instead
[11:15:56] video not ready in time — framed paused instead
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:56] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:56] lockscreen handlers applied: prevnext
[11:15:57] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:57] lockscreen handlers applied: prevnext
[11:15:57] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:57] lockscreen handlers applied: prevnext
[11:15:57] video not ready in time — framed paused instead
[11:15:57] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:57] lockscreen handlers applied: prevnext
[11:15:57] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:15:57] lockscreen handlers applied: prevnext
[11:18:02] seek 151.09s (source=track)
[11:18:06] external native pause detected (echo-aware)
[11:18:06] native pause (track)
[11:18:06] ended repeat=off
[11:18:06] auto-next 33
[11:18:06] swap stand-down (hidden, 2 consecutive fails) — recovery on visible
[11:18:06] lockscreen handlers applied: prevnext
[11:19:19] seek 88.24s (source=track)
[11:19:19] visibility -> visible owner=track kind=track pending=null lock=playing
[11:19:19] hidden recovery on visible: standdown
[11:19:19] track change 0ef6 -> eccd: will reset pos to 0
[11:19:20] MediaSession play (center ▶️)
[11:19:20] track change 0ef6 -> eccd: fresh load

once i came back strike the earth started playing like normal.
[11:19:20] load [34/51] Strike the Earth! (Plains of Passage) - Shovel Knight [OST] autoplay=true (wasPlaying=true)
[11:19:20] play queued behind swap
[11:19:20] pre-publish track playing dur=154.0 pos=0.00 rate=1
[11:19:20] preload cached [35] A Hat in Time OST [Seal 
[11:19:20] preload cached [33] 【Kasane Teto SV2】Brain R
[11:19:20] native playing (track, same element)
[11:19:20] post-publish track playing dur=224.7 pos=0.00 rate=1 state=playing
[11:19:20] track source active on permanent element @ 0.00s +video playing owner=track
[11:19:20] direct resume pre-publish playing pos=0.00
[11:19:20] track resumed on permanent element @ 0.00s rate=1 state=playing direct
[11:19:21] building same-element placeholder 224.7s @ 8000 Hz (~3510 KB)
/*/