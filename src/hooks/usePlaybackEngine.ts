import { useCallback, useEffect, useRef, useState } from "react";
import { createSilentWavBlob } from "../lib/silentAudio";

export interface Track {
  id: string;
  file: File;
  url: string;
  name: string;
  mediaType: "audio" | "video";
}

export type ElementMode = "dual" | "video-only" | "audio-only";

/**
 * Who currently "owns" the Media Session / iOS lock-screen seek bar.
 *  - "track"  : real media is playing; setPositionState reports the track
 *  - "anchor" : real media is paused; silent duration-matched audio is playing
 *               at the frozen track position to keep the iOS audio session alive
 *  - "none"   : idle (no track, or fully stopped)
 */
export type SessionOwner = "track" | "anchor" | "none";

interface MediaDiagnostics {
  owner: SessionOwner;
  trackPaused: boolean | null;
  anchorPaused: boolean | null;
  trackTime: number | null;
  anchorTime: number | null;
  frozenPosition: number;
}

interface EngineOptions {
  elementMode: ElementMode;
  handoffEnabled: boolean;
  log: (msg: string) => void;
}

function setAudioSessionType() {
  try {
    const audioSession = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (audioSession) audioSession.type = "playback";
  } catch {
    /* ignore */
  }
}

function hideOffscreen(el: HTMLElement) {
  Object.assign(el.style, {
    position: "fixed",
    left: "-2px",
    top: "-2px",
    width: "1px",
    height: "1px",
    opacity: "0",
    pointerEvents: "none",
  });
}

function updatePositionState(el: HTMLMediaElement, forcedPosition?: number) {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(el.duration) || el.duration <= 0) return;
  const position = forcedPosition ?? el.currentTime;
  try {
    navigator.mediaSession.setPositionState({
      duration: el.duration,
      playbackRate: el.playbackRate || 1,
      position: Math.min(Math.max(0, position), el.duration),
    });
  } catch {
    /* iOS can throw if called too early */
  }
}

/**
 * iOS-hardened playback engine with exclusive silent-anchor handoff.
 *
 * Problem this solves
 * -------------------
 * iOS kills background media sessions shortly after the only playing <audio>/<video>
 * is paused. A looping silent <audio> keeps the session alive, BUT if it plays at the
 * same time as the real track, iOS merges both into the lock-screen seek bar and the
 * bar snaps between the two positions / durations.
 *
 * Solution: exclusive ownership (handoff)
 * --------------------------------------
 *  PLAYING  -> track owns the session. Anchor is fully paused + has no src (or is
 *              paused at the same position). setPositionState only ever reports the
 *              track. No snap.
 *  PAUSED   -> track pauses. Anchor is loaded with a silence WAV whose *duration
 *              matches the track*, its currentTime is snapped to the track's paused
 *              position, then it starts playing (near-silent). While it plays we
 *              pin its currentTime every animation frame so the seek bar stays
 *              frozen at the paused position. setPositionState reports the frozen
 *              track position with playbackRate 0 (or 1 on the frozen anchor —
 *              both work; we use the track's duration + frozen position).
 *  RESUME   -> anchor pauses (and we stop pinning). Track resumes from the frozen
 *              position. Ownership flips back.
 *
 * The "rewind 1s every second" idea is covered by the pin loop: every frame we
 * force anchor.currentTime = frozenPosition, which is stronger and smoother than
 * a 1 Hz rewind.
 */
export function usePlaybackEngine({ elementMode, handoffEnabled, log }: EngineOptions) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sessionOwner, setSessionOwner] = useState<SessionOwner>("none");

  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const anchorRef = useRef<HTMLAudioElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const rafSyncRef = useRef(0);
  const rafPinRef = useRef(0);
  const frozenPositionRef = useRef(0);
  const frozenDurationRef = useRef(0);
  const anchorUrlRef = useRef<string | null>(null);
  const anchorDurationBuiltRef = useRef(0);
  const pendingPlayRef = useRef(false);
  const handoffEnabledRef = useRef(handoffEnabled);
  const elementModeRef = useRef(elementMode);
  const logRef = useRef(log);
  const tracksRef = useRef(tracks);
  const currentIndexRef = useRef(currentIndex);
  const isPlayingRef = useRef(isPlaying);
  const sessionOwnerRef = useRef<SessionOwner>("none");
  const loadGenRef = useRef(0);

  handoffEnabledRef.current = handoffEnabled;
  elementModeRef.current = elementMode;
  logRef.current = log;
  tracksRef.current = tracks;
  currentIndexRef.current = currentIndex;
  isPlayingRef.current = isPlaying;
  sessionOwnerRef.current = sessionOwner;

  const currentTrack = tracks[currentIndex] ?? null;

  const getDiagnostics = useCallback((): MediaDiagnostics => {
    const track = mediaRef.current;
    const anchor = anchorRef.current;
    return {
      owner: sessionOwnerRef.current,
      trackPaused: track ? track.paused : null,
      anchorPaused: anchor ? anchor.paused : null,
      trackTime: track ? track.currentTime : null,
      anchorTime: anchor ? anchor.currentTime : null,
      frozenPosition: frozenPositionRef.current,
    };
  }, []);

  // ---------- low-level helpers ----------

  const stopSyncRaf = () => {
    if (rafSyncRef.current) {
      cancelAnimationFrame(rafSyncRef.current);
      rafSyncRef.current = 0;
    }
  };

  const stopPinRaf = () => {
    if (rafPinRef.current) {
      cancelAnimationFrame(rafPinRef.current);
      rafPinRef.current = 0;
    }
  };

  const pinAnchorToFrozenPosition = useCallback((reason: string) => {
    const anchor = anchorRef.current;
    if (!anchor || sessionOwnerRef.current !== "anchor") return;

    const target = frozenPositionRef.current;
    const maxPos =
      Number.isFinite(anchor.duration) && anchor.duration > 0
        ? Math.max(0, anchor.duration - 0.05)
        : target;
    const clamped = Math.max(0, Math.min(target, maxPos));

    if (Math.abs(anchor.currentTime - clamped) > 0.03) {
      try {
        anchor.currentTime = clamped;
      } catch {
        /* ignore */
      }
    }

    // The MediaSession position is intentionally the frozen *track* position,
    // not the anchor's advancing currentTime.
    if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
      try {
        navigator.mediaSession?.setPositionState({
          duration: frozenDurationRef.current,
          playbackRate: 1,
          position: Math.min(target, frozenDurationRef.current),
        });
      } catch {
        /* ignore */
      }
    }

    // Keep this log rare; the event log is useful on iOS and too much spam hurts.
    if (reason === "remote-seek") {
      logRef.current(`anchor pinned via ${reason} @ ${clamped.toFixed(1)}s`);
    }
  }, []);

  const startVideoSync = useCallback(() => {
    stopSyncRaf();
    const tick = () => {
      const audio = mediaRef.current;
      const video = videoRef.current;
      if (audio && video && !audio.paused) {
        const diff = Math.abs(video.currentTime - audio.currentTime);
        if (diff > 0.12) {
          try {
            video.currentTime = audio.currentTime;
          } catch {
            /* ignore */
          }
        }
        if (video.paused) video.play().catch(() => {});
      }
      if (mediaRef.current && !mediaRef.current.paused) {
        rafSyncRef.current = requestAnimationFrame(tick);
      }
    };
    rafSyncRef.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Build (or rebuild) the silent anchor so its reported duration matches `targetDuration`.
   * Reuses the existing blob when the duration hasn't meaningfully changed.
   */
  const ensureAnchorDuration = useCallback(async (targetDuration: number) => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const safe = Math.max(1, Number.isFinite(targetDuration) ? targetDuration : 2);

    // Rebuild only if duration drifted by more than half a second.
    if (
      anchorUrlRef.current &&
      Math.abs(anchorDurationBuiltRef.current - safe) < 0.5 &&
      Number.isFinite(anchor.duration) &&
      anchor.duration > 0
    ) {
      return;
    }

    if (anchorUrlRef.current) {
      URL.revokeObjectURL(anchorUrlRef.current);
      anchorUrlRef.current = null;
    }

    const blob = createSilentWavBlob(safe);
    const url = URL.createObjectURL(blob);
    anchorUrlRef.current = url;
    anchorDurationBuiltRef.current = safe;

    await new Promise<void>((resolve) => {
      const onMeta = () => {
        anchor.removeEventListener("loadedmetadata", onMeta);
        resolve();
      };
      anchor.addEventListener("loadedmetadata", onMeta);
      anchor.src = url;
      anchor.load();
      // Safety timeout so we never hang if metadata never fires.
      setTimeout(() => {
        anchor.removeEventListener("loadedmetadata", onMeta);
        resolve();
      }, 500);
    });

    logRef.current(
      `anchor rebuilt: target=${safe.toFixed(1)}s actual=${
        Number.isFinite(anchor.duration) ? anchor.duration.toFixed(1) : "?"
      }s`
    );
  }, []);

  /**
   * Hand session ownership to the silent anchor, frozen at the track's current position.
   * Called on pause (and whenever we need the session kept alive without the track playing).
   */
  const handoffToAnchor = useCallback(async () => {
    if (!handoffEnabledRef.current) return;
    const track = mediaRef.current;
    const anchor = anchorRef.current;
    if (!track || !anchor) return;

    const pos = Number.isFinite(track.currentTime) ? track.currentTime : 0;
    const dur =
      Number.isFinite(track.duration) && track.duration > 0
        ? track.duration
        : frozenDurationRef.current || 2;

    frozenPositionRef.current = pos;
    frozenDurationRef.current = dur;

    await ensureAnchorDuration(dur);

    // Snap anchor to the exact paused position of the track.
    try {
      // Clamp in case the generated WAV is slightly shorter than the real track.
      const maxPos = Number.isFinite(anchor.duration) && anchor.duration > 0 ? anchor.duration - 0.05 : pos;
      anchor.currentTime = Math.max(0, Math.min(pos, maxPos));
    } catch {
      /* ignore */
    }

    setAudioSessionType();
    try {
      await anchor.play();
    } catch (err) {
      logRef.current(`anchor.play() failed: ${String(err)}`);
      // Retry once — same stale-session pattern as the real track.
      await new Promise((r) => setTimeout(r, 100));
      try {
        setAudioSessionType();
        await anchor.play();
      } catch (err2) {
        logRef.current(`anchor.play() retry failed: ${String(err2)}`);
        return;
      }
    }

    // Slow the anchor as much as the engine allows. If iOS honors this, the
    // lock-screen clock barely moves. If it ignores it, the timeupdate handler
    // below still snaps it back whenever Safari lets JS run.
    try {
      anchor.playbackRate = 0.0001;
    } catch {
      try {
        anchor.playbackRate = 0.0625;
      } catch {
        /* ignore */
      }
    }

    // Pin the anchor's currentTime while the app is foregrounded. On the lock
    // screen iOS pauses requestAnimationFrame, so we also pin from the anchor's
    // own timeupdate event (registered on mount below).
    stopPinRaf();
    const pin = () => {
      const a = anchorRef.current;
      if (!a || a.paused || sessionOwnerRef.current !== "anchor") return;
      pinAnchorToFrozenPosition("raf");
      rafPinRef.current = requestAnimationFrame(pin);
    };
    rafPinRef.current = requestAnimationFrame(pin);

    setSessionOwner("anchor");
    sessionOwnerRef.current = "anchor";
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    logRef.current(
      `handoff -> ANCHOR @ ${pos.toFixed(1)}s / ${dur.toFixed(1)}s (session kept alive)`
    );
  }, [ensureAnchorDuration, pinAnchorToFrozenPosition]);

  /**
   * Hand session ownership back to the real track. Stops the anchor completely
   * so it cannot compete for the seek bar.
   */
  const handoffToTrack = useCallback(() => {
    const anchor = anchorRef.current;
    stopPinRaf();
    if (anchor) {
      anchor.pause();
      // Hard-release the anchor on resume. Leaving the source attached can make
      // iOS keep treating it as the active lock-screen item in standalone PWAs.
      anchor.removeAttribute("src");
      anchor.load();
      if (anchorUrlRef.current) {
        URL.revokeObjectURL(anchorUrlRef.current);
        anchorUrlRef.current = null;
      }
      anchorDurationBuiltRef.current = 0;
    }
    setSessionOwner("track");
    sessionOwnerRef.current = "track";
    logRef.current("handoff -> TRACK (anchor paused)");
  }, []);

  // ---------- public actions ----------

  const play = useCallback(async () => {
    const el = mediaRef.current;
    if (!el || !el.src) {
      logRef.current("play() aborted: no media");
      return;
    }

    if (sessionOwnerRef.current === "anchor") {
      try {
        el.currentTime = frozenPositionRef.current;
      } catch {
        /* ignore */
      }
      logRef.current(
        `resume requested from anchor @ ${frozenPositionRef.current.toFixed(1)}s`
      );
    }

    // Exclusive handoff: stop the anchor BEFORE starting the track so iOS
    // never sees two playing elements at once.
    handoffToTrack();
    setAudioSessionType();

    try {
      await el.play();
    } catch (err) {
      logRef.current(`play() rejected, retrying: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 120));
      try {
        setAudioSessionType();
        await el.play();
      } catch (err2) {
        logRef.current(`play() retry failed: ${String(err2)}`);
        setIsPlaying(false);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        // Fall back to anchor so the session still stays alive.
        void handoffToAnchor();
        return;
      }
    }

    if (videoRef.current && videoRef.current.src) {
      try {
        videoRef.current.currentTime = el.currentTime;
        videoRef.current.play().catch(() => {});
      } catch {
        /* ignore */
      }
      startVideoSync();
    }

    setIsPlaying(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updatePositionState(el);
    logRef.current(`play() succeeded @ ${el.currentTime.toFixed(1)}s`);
  }, [handoffToTrack, handoffToAnchor, startVideoSync]);

  const pause = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;

    // Capture position BEFORE pausing so the freeze point is exact.
    frozenPositionRef.current = el.currentTime;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      frozenDurationRef.current = el.duration;
    }

    el.pause();
    videoRef.current?.pause();
    stopSyncRaf();

    setIsPlaying(false);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "paused";
      updatePositionState(el, frozenPositionRef.current);
    }

    // Hand the live session over to the duration-matched silent anchor.
    void handoffToAnchor();
    logRef.current(`pause() @ ${frozenPositionRef.current.toFixed(1)}s`);
  }, [handoffToAnchor]);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (sessionOwnerRef.current === "anchor") {
      logRef.current("togglePlay: anchor owns session -> resume track");
      void play();
      return;
    }
    // Prefer real element state — React state can desync after lock-screen actions.
    if (el.paused) void play();
    else pause();
  }, [play, pause]);

  const remotePauseOrResume = useCallback(() => {
    const owner = sessionOwnerRef.current;
    const anchor = anchorRef.current;
    const track = mediaRef.current;

    // This is the key iOS quirk from your latest test: because the anchor is
    // actually playing while the user-facing track is paused, iOS displays a
    // pause button and fires the MediaSession "pause" action. In that state,
    // "pause" from the lock screen really means "the user is pressing the
    // center transport button to get back to the real track", so we resume.
    if (owner === "anchor" || (track?.paused && anchor && !anchor.paused)) {
      logRef.current(
        `remote pause while anchor active -> resume track (trackPaused=${String(
          track?.paused
        )}, anchorPaused=${String(anchor?.paused)})`
      );
      void play();
      return;
    }

    logRef.current("remote pause -> pause track");
    pause();
  }, [play, pause]);

  const seek = useCallback(
    (time: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const max = Number.isFinite(el.duration) ? el.duration : time;
      const clamped = Math.max(0, Math.min(time, max));
      el.currentTime = clamped;
      if (videoRef.current) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          /* ignore */
        }
      }
      setCurrentTime(clamped);
      frozenPositionRef.current = clamped;

      // If the anchor currently owns the session, keep it pinned to the new position
      // so a scrub-while-paused doesn't jump the lock-screen bar.
      if (sessionOwnerRef.current === "anchor" && anchorRef.current) {
        try {
          const a = anchorRef.current;
          const maxPos =
            Number.isFinite(a.duration) && a.duration > 0 ? a.duration - 0.05 : clamped;
          a.currentTime = Math.max(0, Math.min(clamped, maxPos));
        } catch {
          /* ignore */
        }
        if (Number.isFinite(frozenDurationRef.current) && frozenDurationRef.current > 0) {
          try {
            navigator.mediaSession?.setPositionState({
              duration: frozenDurationRef.current,
              playbackRate: 1,
              position: clamped,
            });
          } catch {
            /* ignore */
          }
        }
      } else {
        updatePositionState(el, clamped);
      }
    },
    []
  );

  const seekRelative = useCallback(
    (delta: number) => {
      const el = mediaRef.current;
      if (!el) return;
      // When paused (anchor owns session), seek relative to the frozen position.
      const base =
        sessionOwnerRef.current === "anchor" ? frozenPositionRef.current : el.currentTime;
      seek(base + delta);
    },
    [seek]
  );

  // ---------- track loading ----------

  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current;
    let video = videoRef.current;
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute("webkit-playsinline", "true");
      video.setAttribute("playsinline", "true");
      video.preload = "auto";
      video.controls = false;
      Object.assign(video.style, {
        width: "100%",
        height: "100%",
        objectFit: "contain",
        borderRadius: "12px",
        touchAction: "manipulation",
        background: "#000",
      });
      videoRef.current = video;
    }
    if (container && video.parentNode !== container) {
      container.innerHTML = "";
      container.appendChild(video);
    }
    if (video.getAttribute("src") !== url) {
      video.src = url;
      video.load();
    }
  }, []);

  const detachVideo = useCallback(() => {
    if (videoRef.current) {
      const v = videoRef.current;
      v.pause();
      v.removeAttribute("src");
      v.load();
      if (v.parentNode) v.parentNode.removeChild(v);
      videoRef.current = null;
    }
  }, []);

  const loadTrack = useCallback(
    async (index: number, autoplay: boolean) => {
      const list = tracksRef.current;
      const track = list[index];
      const el = mediaRef.current;
      if (!track || !el) {
        if (el) {
          el.removeAttribute("src");
          el.load();
        }
        detachVideo();
        stopPinRaf();
        anchorRef.current?.pause();
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setSessionOwner("none");
        return;
      }

      const gen = ++loadGenRef.current;
      stopSyncRaf();
      stopPinRaf();
      anchorRef.current?.pause();
      setSessionOwner("none");
      setCurrentTime(0);
      setDuration(0);

      const mode = elementModeRef.current;
      pendingPlayRef.current = autoplay;

      el.src = track.url;
      el.load();

      if (mode === "dual" || (mode === "video-only" && track.mediaType === "video")) {
        attachVideo(track.url);
      } else if (mode === "video-only") {
        // audio file in video-only mode: still attach so lock screen gets video UI
        attachVideo(track.url);
      } else {
        detachVideo();
      }

      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name,
          artist: "Lock Screen Test Player",
          album: track.mediaType === "video" ? "Video track" : "Audio track",
        });
      }

      setAudioSessionType();
      logRef.current(
        `loadTrack [${index + 1}/${list.length}] ${track.name} (mode=${mode}, autoplay=${autoplay})`
      );

      // Wait for metadata so we can pre-build a duration-matched anchor.
      const waitMeta = new Promise<void>((resolve) => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          resolve();
          return;
        }
        const done = () => {
          el.removeEventListener("loadedmetadata", done);
          resolve();
        };
        el.addEventListener("loadedmetadata", done);
        setTimeout(() => {
          el.removeEventListener("loadedmetadata", done);
          resolve();
        }, 2000);
      });
      await waitMeta;
      if (gen !== loadGenRef.current) return;

      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
        frozenDurationRef.current = el.duration;
        updatePositionState(el);
        // Pre-build the matching silent anchor so pause handoff is instant.
        await ensureAnchorDuration(el.duration);
      }

      if (gen !== loadGenRef.current) return;
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        await play();
      }
    },
    [attachVideo, detachVideo, ensureAnchorDuration, play]
  );

  // ---------- mount persistent elements once ----------

  useEffect(() => {
    // Real track element (source of truth).
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.controls = false;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.setAttribute("x-webkit-airplay", "allow");
    hideOffscreen(audio);
    document.body.appendChild(audio);
    mediaRef.current = audio;

    // Silent anchor — src is set lazily to a duration-matched WAV on first pause/load.
    const anchor = document.createElement("audio");
    anchor.preload = "auto";
    anchor.loop = true;
    anchor.volume = 0.001; // near-silent; some iOS builds ignore volume=0 looping audio
    anchor.setAttribute("playsinline", "true");
    anchor.setAttribute("data-silent-anchor", "true");
    hideOffscreen(anchor);
    document.body.appendChild(anchor);
    anchorRef.current = anchor;

    const onAnchorTimeUpdate = () => {
      // requestAnimationFrame is suspended on the lock screen, but media
      // timeupdate events can still fire for the actively playing anchor.
      // This is our background-safe correction path.
      pinAnchorToFrozenPosition("timeupdate");
    };
    const onAnchorPlay = () => {
      if (sessionOwnerRef.current === "anchor") {
        try {
          anchor.playbackRate = 0.0001;
        } catch {
          /* ignore */
        }
        pinAnchorToFrozenPosition("anchor-play");
      }
    };
    const onAnchorPause = () => {
      if (sessionOwnerRef.current === "anchor") {
        logRef.current("anchor pause event while owner=anchor");
      }
    };
    anchor.addEventListener("timeupdate", onAnchorTimeUpdate);
    anchor.addEventListener("play", onAnchorPlay);
    anchor.addEventListener("pause", onAnchorPause);

    const onTimeUpdate = () => {
      if (mediaRef.current !== audio) return;
      // Only drive UI time from the track while the track owns the session.
      // When the anchor owns it, the UI stays frozen at frozenPositionRef.
      if (sessionOwnerRef.current !== "anchor") {
        setCurrentTime(audio.currentTime);
        updatePositionState(audio);
      }
    };
    const onLoadedMetadata = () => {
      if (mediaRef.current !== audio) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
        frozenDurationRef.current = audio.duration;
        updatePositionState(audio);
      }
    };
    const onPlay = () => {
      if (mediaRef.current !== audio) return;
      setIsPlaying(true);
      setSessionOwner("track");
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
        updatePositionState(audio);
      }
      if (videoRef.current?.src) {
        try {
          videoRef.current.currentTime = audio.currentTime;
          videoRef.current.play().catch(() => {});
        } catch {
          /* ignore */
        }
        startVideoSync();
      }
      logRef.current("track play event");
    };
    const onPause = () => {
      if (mediaRef.current !== audio) return;
      // Ignore spurious pause events fired by iOS while backgrounding if we
      // still intend to be playing (the visibility handler manages that case).
      if (document.visibilityState === "visible" || audio.ended) {
        setIsPlaying(false);
        if ("mediaSession" in navigator) {
          navigator.mediaSession.playbackState = "paused";
          updatePositionState(audio);
        }
        stopSyncRaf();
        logRef.current("track pause event");
      } else {
        logRef.current("track pause event ignored (background/spurious)");
      }
    };
    const onEnded = () => {
      if (mediaRef.current !== audio) return;
      logRef.current("track ended");
      window.dispatchEvent(new CustomEvent("playback-ended"));
    };
    const onError = () => {
      if (mediaRef.current !== audio) return;
      logRef.current("track media error");
      setIsPlaying(false);
    };
    const onSeeked = () => {
      if (mediaRef.current === audio) updatePositionState(audio);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("durationchange", onLoadedMetadata);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    audio.addEventListener("seeked", onSeeked);

    setAudioSessionType();

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onLoadedMetadata);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("seeked", onSeeked);
      anchor.removeEventListener("timeupdate", onAnchorTimeUpdate);
      anchor.removeEventListener("play", onAnchorPlay);
      anchor.removeEventListener("pause", onAnchorPause);
      stopSyncRaf();
      stopPinRaf();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.remove();
      anchor.pause();
      anchor.removeAttribute("src");
      anchor.load();
      anchor.remove();
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current);
      mediaRef.current = null;
      anchorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load when index / list / mode changes.
  useEffect(() => {
    if (tracks.length === 0) {
      const el = mediaRef.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      detachVideo();
      stopPinRaf();
      anchorRef.current?.pause();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setSessionOwner("none");
      return;
    }
    const idx = Math.min(currentIndex, tracks.length - 1);
    if (idx !== currentIndex) {
      setCurrentIndex(idx);
      return;
    }
    void loadTrack(idx, isPlayingRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, tracks, elementMode]);

  // Auto-advance.
  useEffect(() => {
    const onEnded = () => {
      const list = tracksRef.current;
      const idx = currentIndexRef.current;
      if (list.length === 0) return;
      if (idx < list.length - 1) {
        isPlayingRef.current = true;
        setCurrentIndex(idx + 1);
      } else {
        setIsPlaying(false);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        // Keep session alive at end-of-playlist via anchor at the final position.
        void handoffToAnchor();
        logRef.current("Reached end of playlist");
      }
    };
    window.addEventListener("playback-ended", onEnded);
    return () => window.removeEventListener("playback-ended", onEnded);
  }, [handoffToAnchor]);

  // Foreground / background handling.
  useEffect(() => {
    const onVisibility = () => {
      logRef.current(`document.visibilityState -> ${document.visibilityState}`);
      if (document.visibilityState === "visible") {
        const el = mediaRef.current;
        if (el && isPlayingRef.current && el.paused && !el.ended) {
          logRef.current("Foreground: track should be playing but is paused — resuming");
          void play();
        } else if (el && videoRef.current?.src && !el.paused) {
          try {
            videoRef.current.currentTime = el.currentTime;
            videoRef.current.play().catch(() => {});
          } catch {
            /* ignore */
          }
          startVideoSync();
        }
      } else {
        // Backgrounding: pause the muted video (saves battery) but leave the
        // owning audio element (track OR anchor) running.
        videoRef.current?.pause();
        stopSyncRaf();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [play, startVideoSync]);

  // If the user toggles handoff off while the anchor owns the session, release it.
  useEffect(() => {
    if (!handoffEnabled && sessionOwnerRef.current === "anchor") {
      stopPinRaf();
      anchorRef.current?.pause();
      setSessionOwner("none");
      logRef.current("handoff disabled — anchor released");
    }
  }, [handoffEnabled]);

  // ---------- playlist API ----------

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    const newTracks: Track[] = arr.map((file, i) => {
      const isVideo =
        file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
      return {
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        url: URL.createObjectURL(file),
        name: file.name.replace(/\.[^.]+$/, "") || file.name,
        mediaType: isVideo ? "video" : "audio",
      };
    });
    setTracks((prev) => {
      const next = [...prev, ...newTracks];
      logRef.current(
        `Added ${newTracks.length} track(s). Playlist now ${next.length}: ${next
          .map((t) => t.name)
          .join(", ")}`
      );
      return next;
    });
  }, []);

  const removeTrack = useCallback((index: number) => {
    setTracks((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.url);
      const next = prev.filter((_, i) => i !== index);
      logRef.current(`Removed track #${index + 1}. Playlist now ${next.length}`);
      return next;
    });
    setCurrentIndex((prev) => {
      if (index < prev) return prev - 1;
      if (index === prev) return Math.max(0, Math.min(prev, Math.max(0, tracksRef.current.length - 2)));
      return prev;
    });
  }, []);

  const clearPlaylist = useCallback(() => {
    setTracks((prev) => {
      prev.forEach((t) => URL.revokeObjectURL(t.url));
      return [];
    });
    setCurrentIndex(0);
    const el = mediaRef.current;
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    detachVideo();
    stopPinRaf();
    anchorRef.current?.pause();
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSessionOwner("none");
    logRef.current("Playlist cleared");
  }, [detachVideo]);

  const goToTrack = useCallback((index: number) => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const clamped = ((index % list.length) + list.length) % list.length;
    if (mediaRef.current && !mediaRef.current.paused) {
      isPlayingRef.current = true;
    }
    logRef.current(`goToTrack(${clamped}) -> ${list[clamped]?.name}`);
    setCurrentIndex(clamped);
  }, []);

  const nextTrack = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) {
      logRef.current("nextTrack: empty playlist");
      return;
    }
    if (list.length === 1) {
      seek(0);
      void play();
      logRef.current("nextTrack: only one track — restarted");
      return;
    }
    goToTrack(currentIndexRef.current + 1);
  }, [goToTrack, seek, play]);

  const prevTrack = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) {
      logRef.current("prevTrack: empty playlist");
      return;
    }
    const el = mediaRef.current;
    const pos =
      sessionOwnerRef.current === "anchor"
        ? frozenPositionRef.current
        : el?.currentTime ?? 0;
    if (pos > 3) {
      seek(0);
      logRef.current("prevTrack: restarted current track");
      return;
    }
    if (list.length === 1) {
      seek(0);
      return;
    }
    goToTrack(currentIndexRef.current - 1);
  }, [goToTrack, seek]);

  return {
    tracks,
    currentIndex,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    sessionOwner,
    videoContainerRef,
    mediaRef,
    getDiagnostics,
    addFiles,
    removeTrack,
    clearPlaylist,
    play,
    pause,
    remotePauseOrResume,
    togglePlay,
    seek,
    seekRelative,
    nextTrack,
    prevTrack,
    goToTrack,
  };
}
