import { useCallback, useEffect, useRef, useState } from "react";
import { VideoSyncController, type VideoSyncStats } from "../lib/videoSync";

export type VideoSyncMode = "nudge" | "legacy-seek";

export interface Track {
  id: string;
  file: File;
  url: string;
  name: string;
  mediaType: "audio" | "video";
  size: number;
}

export type ElementMode = "dual" | "video-only" | "audio-only";
export type SessionOwner = "track" | "frozen" | "none";

interface EngineOptions {
  elementMode: ElementMode;
  videoSyncMode: VideoSyncMode;
  log: (msg: string) => void;
}

/**
 * PWA-working "single element freeze" engine.
 *
 * Why this exists
 * ---------------
 * Exclusive silent-anchor handoff works in Safari-tab, but Home Screen PWAs
 * often refuse to start a *different* element from a lock-screen command.
 * This engine never introduces a second element. On "pause" we keep the SAME
 * <audio> playing (so iOS never tears the session down) but:
 *   - volume ≈ 0
 *   - playbackRate as close to 0 as Safari allows
 *   - MediaSession.playbackState = "paused"
 *   - setPositionState(..., playbackRate: 0)  ← this is the visual-bug fix
 *
 * The visual seek-bar snap
 * ------------------------
 * iOS Now Playing interpolates:
 *     displayed = lastPosition + (now - lastUpdate) * lastPlaybackRate
 * even when playbackState is "paused", IF lastPlaybackRate was 1 — because the
 * native AVPlayer is still running. On resume it flashes that interpolated
 * time, then JS setPositionState eventually corrects it (~4s later).
 *
 * Fixes applied here:
 *  1. While frozen, ALWAYS publish playbackRate: 0 (never 1).
 *  2. Never let a generic MediaSession helper publish the element's drifted
 *     currentTime / (playbackRate || 1). The engine is the only publisher.
 *  3. On unfreeze, seek back to frozenPos and wait for `seeked` BEFORE
 *     flipping rate to 1 / playbackState to playing.
 *  4. For ~3s after unfreeze, if native currentTime is still way ahead of
 *     expected, re-seek (kills the residual snap).
 */
function setAudioSessionType() {
  try {
    const nav = navigator as unknown as { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = "playback";
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

function publish(position: number, duration: number, playbackRate: number) {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const pos = Math.min(Math.max(0, position), duration);
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate,
      position: pos,
    });
  } catch {
    /* iOS throws if called too early / with bad values */
  }
}

function waitForSeeked(el: HTMLMediaElement, timeoutMs = 600): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("seeked", finish);
      resolve();
    };
    el.addEventListener("seeked", finish);
    window.setTimeout(finish, timeoutMs);
  });
}

function createTrack(file: File, index: number): Track {
  const isVideo =
    file.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name);
  return {
    id: `${Date.now()}-${index}-${file.name}-${file.size}-${file.lastModified}`,
    file,
    url: URL.createObjectURL(file),
    name: file.name.replace(/\.[^.]+$/, "") || file.name,
    mediaType: isVideo ? "video" : "audio",
    size: file.size,
  };
}

export function useFreezeEngine({ elementMode, videoSyncMode, log }: EngineOptions) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sessionOwner, setSessionOwner] = useState<SessionOwner>("none");
  const [videoSyncStats, setVideoSyncStats] = useState<VideoSyncStats | null>(null);

  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const syncRef = useRef<VideoSyncController | null>(null);

  const rafPinRef = useRef(0);
  const frozenPosRef = useRef(0);
  const frozenDurRef = useRef(0);
  const isFrozenRef = useRef(false);
  const lastVolumeRef = useRef(1);
  const loadGenRef = useRef(0);
  const wantAutoplayRef = useRef(false);
  const unfreezeAtRef = useRef(0);
  const unfreezePosRef = useRef(0);

  const logRef = useRef(log);
  logRef.current = log;
  const elementModeRef = useRef(elementMode);
  elementModeRef.current = elementMode;
  const videoSyncModeRef = useRef(videoSyncMode);
  videoSyncModeRef.current = videoSyncMode;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const currentTrack = tracks[currentIndex] ?? null;
  const currentTrackId = currentTrack?.id ?? null;

  const stopPin = () => {
    if (rafPinRef.current) {
      cancelAnimationFrame(rafPinRef.current);
      rafPinRef.current = 0;
    }
  };
  const stopVideo = () => {
    syncRef.current?.stop();
  };

  const applyFrozenRate = (el: HTMLMediaElement) => {
    // Prefer real 0 — that's what actually stops AVPlayer interpolation.
    // Some Safari builds reject 0; fall back to the smallest positive rate.
    try {
      el.playbackRate = 0;
      if (el.playbackRate !== 0) throw new Error("rate 0 ignored");
    } catch {
      try {
        el.playbackRate = 0.0001;
      } catch {
        try {
          el.playbackRate = 0.0625;
        } catch {
          /* ignore */
        }
      }
    }
  };

  const publishFrozen = useCallback(() => {
    const dur = frozenDurRef.current;
    const pos = frozenPosRef.current;
    // CRITICAL: rate 0. If we publish 1, iOS interpolates the lock-screen bar
    // as if the track kept playing, which is exactly the snap-on-resume bug.
    publish(pos, dur, 0);
  }, []);

  const pinFrozen = useCallback(() => {
    const el = mediaRef.current;
    if (!el || !isFrozenRef.current) return;
    const target = frozenPosRef.current;
    if (Math.abs(el.currentTime - target) > 0.04) {
      try {
        el.currentTime = target;
      } catch {
        /* ignore */
      }
    }
    publishFrozen();
  }, [publishFrozen]);

  const startPinLoop = useCallback(() => {
    stopPin();
    const tick = () => {
      if (!isFrozenRef.current || !mediaRef.current) return;
      pinFrozen();
      rafPinRef.current = requestAnimationFrame(tick);
    };
    rafPinRef.current = requestAnimationFrame(tick);
  }, [pinFrozen]);

  /**
   * A/V sync is delegated to VideoSyncController (src/lib/videoSync.ts):
   * rate-nudge for small drift, one guarded seek for large drift, never a seek
   * while one is in flight. See that file for the full rationale.
   */
  const getSync = useCallback(() => {
    if (!syncRef.current) {
      let lastStatsEmit = 0;
      syncRef.current = new VideoSyncController({
        getAudio: () => mediaRef.current,
        getVideo: () => videoRef.current,
        isActive: () => {
          const a = mediaRef.current;
          return !!a && !isFrozenRef.current && !a.paused && document.visibilityState === "visible";
        },
        mode: videoSyncModeRef.current,
        log: (m) => logRef.current(m),
        onStats: (s) => {
          // Throttle React updates to ~4Hz; the controller itself already runs at 4Hz.
          const now = performance.now();
          if (now - lastStatsEmit > 200) {
            lastStatsEmit = now;
            setVideoSyncStats(s);
          }
        },
      });
    }
    return syncRef.current;
  }, []);

  const startVideoSync = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.src) return;
    getSync().start();
  }, [getSync]);

  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current;
    let v = videoRef.current;
    if (!v) {
      v = document.createElement("video");
      // These five together are what keep the <video> from ever becoming the
      // Now Playing / lock-screen session owner. Never unmute this element —
      // volume lives on the <audio>.
      v.muted = true;
      v.defaultMuted = true;
      v.playsInline = true;
      v.setAttribute("webkit-playsinline", "true");
      v.setAttribute("playsinline", "true");
      v.setAttribute("x-webkit-airplay", "deny");
      try {
        (v as unknown as { disableRemotePlayback: boolean }).disableRemotePlayback = true;
      } catch {
        /* ignore */
      }
      try {
        (v as unknown as { disablePictureInPicture: boolean }).disablePictureInPicture = true;
      } catch {
        /* ignore */
      }
      // "auto" so the decoder is warm before the first play(); with blob URLs
      // this costs nothing on the network and removes the cold-start hitch.
      v.preload = "auto";
      v.controls = false;
      Object.assign(v.style, {
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "#000",
        display: "block",
      });
      videoRef.current = v;
    }
    // Container must be a dedicated, React-childless div. We never touch
    // innerHTML so React-owned overlay siblings stay intact.
    if (container && v.parentNode !== container) {
      container.appendChild(v);
    }
    if (v.getAttribute("src") !== url) {
      v.src = url;
      v.load();
    }
  }, []);

  const detachVideo = useCallback(() => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    v.pause();
    v.removeAttribute("src");
    v.load();
    if (v.parentNode) v.parentNode.removeChild(v);
    videoRef.current = null;
  }, []);

  const getDiagnostics = useCallback(() => {
    const el = mediaRef.current;
    return {
      owner: isFrozenRef.current
        ? ("frozen" as SessionOwner)
        : el && !el.paused
          ? ("track" as SessionOwner)
          : ("none" as SessionOwner),
      trackPaused: el ? el.paused : null,
      trackTime: el ? el.currentTime : null,
      frozenPosition: frozenPosRef.current,
      rate: el ? el.playbackRate : null,
      volume: el ? el.volume : null,
    };
  }, []);

  const play = useCallback(async () => {
    const el = mediaRef.current;
    if (!el || !el.src) {
      logRef.current("play aborted: no src");
      return;
    }

    setAudioSessionType();

    if (isFrozenRef.current) {
      const pos = frozenPosRef.current;
      const dur =
        Number.isFinite(el.duration) && el.duration > 0
          ? el.duration
          : frozenDurRef.current;

      logRef.current(`unfreeze: seek ${pos.toFixed(1)}s then restore rate/volume`);

      // 1. Stop Now Playing interpolation BEFORE anything else.
      publish(pos, dur, 0);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";

      // 2. Seek back to the freeze point and wait. If we restore rate=1 first,
      // iOS samples the drifted native currentTime and the bar jumps forward.
      try {
        el.currentTime = pos;
      } catch {
        /* ignore */
      }
      await waitForSeeked(el);

      stopPin();
      isFrozenRef.current = false;
      unfreezeAtRef.current = performance.now();
      unfreezePosRef.current = pos;

      try {
        el.volume = lastVolumeRef.current;
      } catch {
        /* ignore */
      }
      try {
        el.playbackRate = 1;
      } catch {
        /* ignore */
      }

      publish(pos, dur, 1);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    }

    try {
      await el.play();
    } catch (e) {
      logRef.current(`play failed: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 120));
      try {
        setAudioSessionType();
        await el.play();
      } catch (e2) {
        logRef.current(`play retry failed: ${String(e2)}`);
        return;
      }
    }

    // Re-assert freeze point in case play() used drifted native time.
    if (unfreezeAtRef.current && performance.now() - unfreezeAtRef.current < 1500) {
      const expected = unfreezePosRef.current;
      if (Math.abs(el.currentTime - expected) > 0.4) {
        logRef.current(
          `post-play snap correct ${el.currentTime.toFixed(1)} -> ${expected.toFixed(1)}`
        );
        try {
          el.currentTime = expected;
        } catch {
          /* ignore */
        }
      }
    }

    if (videoRef.current?.src) {
      // One deliberate, latency-compensated seek on resume, then the controller
      // keeps it locked with rate nudges (no further seeks unless drift > 1.2s).
      getSync().hardSync("resume");
      videoRef.current.play().catch(() => {});
      startVideoSync();
    }

    setIsPlaying(true);
    isPlayingRef.current = true;
    setSessionOwner("track");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    publish(el.currentTime, el.duration, 1);
    setCurrentTime(el.currentTime);
    logRef.current(`play ok @ ${el.currentTime.toFixed(1)}s vol=${el.volume.toFixed(3)}`);
  }, [startVideoSync]);

  const pause = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;

    frozenPosRef.current = el.currentTime;
    frozenDurRef.current =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 2;
    lastVolumeRef.current = el.volume || 1;

    logRef.current(
      `freeze @ ${frozenPosRef.current.toFixed(1)}s / ${frozenDurRef.current.toFixed(1)}s (keep element playing, rate→0, vol→0.001)`
    );

    // Do NOT call el.pause() — that is what kills the PWA session.
    try {
      el.volume = 0.001;
    } catch {
      /* ignore */
    }
    applyFrozenRate(el);

    isFrozenRef.current = true;
    setIsPlaying(false);
    isPlayingRef.current = false;
    setSessionOwner("frozen");
    setCurrentTime(frozenPosRef.current);

    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    publishFrozen();

    startPinLoop();
    videoRef.current?.pause();
    stopVideo();

    if (el.paused) {
      setAudioSessionType();
      el.play().catch((e) => logRef.current(`freeze play failed: ${String(e)}`));
    }
  }, [publishFrozen, startPinLoop]);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (isFrozenRef.current) {
      void play();
      return;
    }
    if (el.paused) void play();
    else pause();
  }, [play, pause]);

  const remotePauseOrResume = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    logRef.current(`remote pause/resume frozen=${isFrozenRef.current} paused=${el.paused}`);
    if (isFrozenRef.current) void play();
    else pause();
  }, [play, pause]);

  const seek = useCallback(
    (t: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const max = Number.isFinite(el.duration) ? el.duration : t;
      const clamped = Math.max(0, Math.min(t, max));

      if (isFrozenRef.current) {
        frozenPosRef.current = clamped;
        try {
          el.currentTime = clamped;
        } catch {
          /* ignore */
        }
        if (videoRef.current) {
          try {
            videoRef.current.currentTime = clamped;
          } catch {
            /* ignore */
          }
        }
        setCurrentTime(clamped);
        publishFrozen();
        return;
      }

      el.currentTime = clamped;
      if (videoRef.current) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          /* ignore */
        }
      }
      setCurrentTime(clamped);
      publish(clamped, el.duration, el.playbackRate || 1);
    },
    [publishFrozen]
  );

  const seekRelative = useCallback(
    (d: number) => {
      const el = mediaRef.current;
      if (!el) return;
      const base = isFrozenRef.current ? frozenPosRef.current : el.currentTime;
      seek(base + d);
    },
    [seek]
  );

  const loadTrack = useCallback(
    async (index: number, autoplay: boolean) => {
      const list = tracksRef.current;
      const track = list[index];
      const el = mediaRef.current;
      const gen = ++loadGenRef.current;

      if (!track || !el) {
        if (el) {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        detachVideo();
        stopPin();
        isFrozenRef.current = false;
        setIsPlaying(false);
        isPlayingRef.current = false;
        setCurrentTime(0);
        setDuration(0);
        setSessionOwner("none");
        return;
      }

      stopVideo();
      stopPin();
      isFrozenRef.current = false;
      frozenPosRef.current = 0;
      el.volume = 1;
      try {
        el.playbackRate = 1;
      } catch {
        /* ignore */
      }
      setCurrentTime(0);
      setDuration(0);

      el.src = track.url;
      el.load();

      const mode = elementModeRef.current;
      // Only attach a <video> for actual video files. Loading an audio file into
      // a muted <video> just burns a second decoder for nothing.
      if (mode === "audio-only" || track.mediaType !== "video") detachVideo();
      else attachVideo(track.url);

      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.name,
          artist: "Lock Screen Test Player",
          album: track.mediaType === "video" ? "Video track" : "Audio track",
        });
      }
      setAudioSessionType();
      logRef.current(
        `loadTrack [${index + 1}/${list.length}] ${track.name} autoplay=${autoplay}`
      );

      await new Promise<void>((res) => {
        if (Number.isFinite(el.duration) && el.duration > 0) {
          res();
          return;
        }
        const done = () => {
          el.removeEventListener("loadedmetadata", done);
          res();
        };
        el.addEventListener("loadedmetadata", done);
        setTimeout(() => {
          el.removeEventListener("loadedmetadata", done);
          res();
        }, 2500);
      });
      if (gen !== loadGenRef.current) return;

      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
        frozenDurRef.current = el.duration;
        publish(0, el.duration, 1);
      }

      if (autoplay) await play();
    },
    [attachVideo, detachVideo, play]
  );

  // Persistent <audio> element.
  useEffect(() => {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.controls = false;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.setAttribute("x-webkit-airplay", "allow");
    hideOffscreen(audio);
    document.body.appendChild(audio);
    mediaRef.current = audio;

    const onTime = () => {
      if (mediaRef.current !== audio) return;
      if (isFrozenRef.current) {
        pinFrozen();
        setCurrentTime(frozenPosRef.current);
        return;
      }

      // After unfreeze, if iOS still reports the interpolated (too-far-ahead)
      // time, yank it back for a few seconds. This is the remaining visual snap.
      if (unfreezeAtRef.current && performance.now() - unfreezeAtRef.current < 3500) {
        const elapsed = (performance.now() - unfreezeAtRef.current) / 1000;
        const expected = unfreezePosRef.current + elapsed;
        if (audio.currentTime - expected > 0.75) {
          logRef.current(
            `timeupdate snap correct ${audio.currentTime.toFixed(1)} -> ${expected.toFixed(1)}`
          );
          try {
            audio.currentTime = expected;
          } catch {
            /* ignore */
          }
          publish(expected, audio.duration, 1);
          setCurrentTime(expected);
          return;
        }
      }

      setCurrentTime(audio.currentTime);
      publish(audio.currentTime, audio.duration, audio.playbackRate || 1);
    };

    const onMeta = () => {
      if (mediaRef.current !== audio) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
        frozenDurRef.current = audio.duration;
        if (isFrozenRef.current) publishFrozen();
        else publish(audio.currentTime, audio.duration, audio.playbackRate || 1);
      }
    };

    const onPlay = () => {
      if (mediaRef.current !== audio) return;
      if (isFrozenRef.current) {
        // Expected — freeze keeps the element playing.
        return;
      }
      setIsPlaying(true);
      isPlayingRef.current = true;
      setSessionOwner("track");
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      publish(audio.currentTime, audio.duration, 1);
      if (videoRef.current?.src) {
        // Don't seek here — play() already did one hardSync. A second seek right
        // behind it is exactly the double-seek start hitch.
        videoRef.current.play().catch(() => {});
        startVideoSync();
      }
    };

    const onPause = () => {
      if (mediaRef.current !== audio) return;
      if (isFrozenRef.current) {
        // iOS may pause us in the PWA. Keep the freeze session alive.
        logRef.current("native pause while frozen — restarting element");
        setAudioSessionType();
        audio.play().catch(() => {});
        return;
      }
      if (document.visibilityState === "visible" || audio.ended) {
        setIsPlaying(false);
        isPlayingRef.current = false;
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        publish(audio.currentTime, audio.duration, 0);
        stopVideo();
        logRef.current("track pause event");
      } else {
        logRef.current("pause ignored (background)");
      }
    };

    const onEnded = () => {
      if (mediaRef.current !== audio) return;
      if (isFrozenRef.current) return;
      logRef.current("track ended");
      window.dispatchEvent(new CustomEvent("playback-ended"));
    };

    const onError = () => {
      if (mediaRef.current !== audio) return;
      logRef.current("track error");
      setIsPlaying(false);
      isPlayingRef.current = false;
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    setAudioSessionType();

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      stopVideo();
      stopPin();
      syncRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.remove();
      mediaRef.current = null;
    };
  }, [pinFrozen, publishFrozen, startVideoSync]);

  // Load only when the *current track identity* changes — NOT when the playlist
  // array grows. Reloading on every addFiles() is what made next-track look dead.
  useEffect(() => {
    if (!currentTrackId) {
      const el = mediaRef.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      detachVideo();
      stopPin();
      isFrozenRef.current = false;
      setIsPlaying(false);
      isPlayingRef.current = false;
      setCurrentTime(0);
      setDuration(0);
      setSessionOwner("none");
      return;
    }
    const autoplay = wantAutoplayRef.current || isPlayingRef.current || isFrozenRef.current;
    wantAutoplayRef.current = false;
    void loadTrack(currentIndexRef.current, autoplay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrackId, elementMode]);

  // Auto-advance.
  useEffect(() => {
    const onEnded = () => {
      const list = tracksRef.current;
      const idx = currentIndexRef.current;
      if (list.length === 0) return;
      if (idx < list.length - 1) {
        wantAutoplayRef.current = true;
        isPlayingRef.current = true;
        logRef.current(`auto-advance -> ${idx + 2}/${list.length}`);
        setCurrentIndex(idx + 1);
      } else {
        logRef.current("end of playlist — freeze keep-alive");
        pause();
      }
    };
    window.addEventListener("playback-ended", onEnded);
    return () => window.removeEventListener("playback-ended", onEnded);
  }, [pause]);

  useEffect(() => {
    const onVis = () => {
      logRef.current(`visibility -> ${document.visibilityState}`);
      const el = mediaRef.current;
      if (document.visibilityState === "visible") {
        if (el && isFrozenRef.current && el.paused) {
          setAudioSessionType();
          el.play().catch(() => {});
          startPinLoop();
        } else if (el && !isFrozenRef.current && isPlayingRef.current && el.paused && !el.ended) {
          void play();
        } else if (el && !isFrozenRef.current && !el.paused && videoRef.current?.src) {
          // Audio kept playing in background; video was paused. One precise
          // catch-up seek, then hand back to the nudge loop.
          getSync().hardSync("foreground");
          videoRef.current.play().catch(() => {});
          startVideoSync();
        }
      } else {
        videoRef.current?.pause();
        stopVideo();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [play, startPinLoop, getSync, startVideoSync]);

  // Live A/B switch between nudge and legacy seek sync.
  useEffect(() => {
    syncRef.current?.setMode(videoSyncMode);
  }, [videoSyncMode]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    if (arr.length === 0) return;
    const nt = arr.map((f, i) => createTrack(f, i));
    setTracks((prev) => {
      const next = [...prev, ...nt];
      logRef.current(`Added ${nt.length}. Playlist now ${next.length}`);
      return next;
    });
  }, []);

  const removeTrack = useCallback((id: string) => {
    setTracks((prev) => {
      const index = prev.findIndex((t) => t.id === id);
      if (index < 0) return prev;
      URL.revokeObjectURL(prev[index].url);
      const next = prev.filter((t) => t.id !== id);
      setCurrentIndex((cur) => {
        if (index < cur) return cur - 1;
        if (index === cur) return Math.min(cur, Math.max(0, next.length - 1));
        return cur;
      });
      logRef.current(`Removed track. Playlist now ${next.length}`);
      return next;
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
    stopPin();
    isFrozenRef.current = false;
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentTime(0);
    setDuration(0);
    setSessionOwner("none");
    logRef.current("Playlist cleared");
  }, [detachVideo]);

  const goToTrack = useCallback((index: number) => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const clamped = ((index % list.length) + list.length) % list.length;
    const keepGoing = isPlayingRef.current || isFrozenRef.current;
    wantAutoplayRef.current = keepGoing;
    if (keepGoing) isPlayingRef.current = true;
    logRef.current(`goToTrack(${clamped}) -> ${list[clamped]?.name} autoplay=${keepGoing}`);
    if (clamped === currentIndexRef.current) {
      seek(0);
      if (keepGoing) void play();
      return;
    }
    setCurrentIndex(clamped);
  }, [seek, play]);

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
    if (list.length === 0) return;
    const el = mediaRef.current;
    const pos = isFrozenRef.current ? frozenPosRef.current : el?.currentTime ?? 0;
    if (pos > 3) {
      seek(0);
      logRef.current("prevTrack: restarted current");
      return;
    }
    if (list.length === 1) {
      seek(0);
      return;
    }
    goToTrack(currentIndexRef.current - 1);
  }, [goToTrack, seek]);

  const armSession = useCallback(async () => {
    const el = mediaRef.current;
    if (!el) return false;
    if (!el.paused && !isFrozenRef.current) {
      logRef.current("arm skipped: already playing");
      return true;
    }
    try {
      setAudioSessionType();
      const wasFrozen = isFrozenRef.current;
      await el.play();
      await new Promise((r) => setTimeout(r, 80));
      if (wasFrozen) {
        applyFrozenRate(el);
        el.volume = 0.001;
      } else {
        el.pause();
      }
      logRef.current("arm done");
      return true;
    } catch (e) {
      logRef.current(`arm failed: ${String(e)}`);
      return false;
    }
  }, []);

  const recoverSession = useCallback(async () => {
    logRef.current("recover: reload current track");
    stopVideo();
    stopPin();
    isFrozenRef.current = false;
    setIsPlaying(false);
    isPlayingRef.current = false;
    setSessionOwner("none");
    const idx = currentIndexRef.current;
    if (tracksRef.current[idx]) await loadTrack(idx, false);
  }, [loadTrack]);

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
    isFrozen: sessionOwner === "frozen",
    videoSyncStats,
    getDiagnostics,
    addFiles,
    removeTrack,
    clearPlaylist,
    armSession,
    recoverSession,
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
