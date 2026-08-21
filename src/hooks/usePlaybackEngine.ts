import { useCallback, useEffect, useRef, useState } from "react";
import { createSilentWavUrl, describeSilentWav } from "../lib/silentAudio";
import { delay, setPlaybackAudioSession } from "../lib/audioSession";
import {
  createTrack,
  type AnchorMode,
  type PlaylistTrack,
  type RepeatMode,
  type SessionOwner,
  type SessionStyle,
} from "../lib/types";

function hideOffscreen(el: HTMLElement) {
  el.style.position = "fixed";
  el.style.left = "-8px";
  el.style.top = "-8px";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
}

function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const pos = Math.min(Math.max(0, position), duration);
  try {
    navigator.mediaSession.setPositionState({ duration, playbackRate, position: pos });
  } catch {
    if (playbackRate === 0) {
      try {
        navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: pos });
      } catch {
        /* iOS can throw if the session isn't ready */
      }
    }
  }
}

/**
 * Handoff playback engine.
 *
 * Only ONE element is allowed to be playing at a time:
 *   - User playing  → the real track plays, silent placeholder is paused
 *   - User paused   → the real track is paused, a silent WAV of the SAME
 *                     duration is seeked to the same currentTime and plays
 *                     (rewinding 1s every 1s so the seek bar stays put)
 *   - Resume        → placeholder pauses, track plays from the frozen time
 *
 * That is the only way to keep the iOS audio session alive through pause
 * without the lock-screen seek bar snapping between two different durations.
 */
export function usePlaybackEngine() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const silentRef = useRef<HTMLAudioElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const silentUrlRef = useRef<string>("");
  const silentDurationRef = useRef(0);
  const frozenPosRef = useRef(0);
  const ownerRef = useRef<SessionOwner>("idle");
  const handoffLockRef = useRef(false);
  const ignoreTrackPauseRef = useRef(false);
  const ignoreSilentPauseRef = useRef(false);
  const rafRef = useRef(0);

  const tracksRef = useRef<PlaylistTrack[]>([]);
  const indexRef = useRef(0);
  const repeatRef = useRef<RepeatMode>("all");
  const styleRef = useRef<SessionStyle>("audio-only");
  const anchorModeRef = useRef<AnchorMode>("handoff");
  const pendingPlayRef = useRef(false);
  const durationRef = useRef(0);

  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("all");
  const [sessionStyle, setSessionStyle] = useState<SessionStyle>("audio-only");
  const [anchorMode, setAnchorMode] = useState<AnchorMode>("handoff");
  const [sessionOwner, setSessionOwner] = useState<SessionOwner>("idle");
  const [anchorTime, setAnchorTime] = useState(0);
  const [anchorDuration, setAnchorDuration] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  tracksRef.current = tracks;
  indexRef.current = currentIndex;
  repeatRef.current = repeatMode;
  styleRef.current = sessionStyle;
  anchorModeRef.current = anchorMode;
  durationRef.current = duration;

  const log = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-249), `[${time}] ${msg}`]);
  }, []);

  const setOwner = useCallback((owner: SessionOwner) => {
    ownerRef.current = owner;
    setSessionOwner(owner);
  }, []);

  const getAudio = useCallback(() => audioRef.current, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  }, []);

  const startVideoFrames = useCallback(() => {
    stopRaf();
    const tick = () => {
      const audio = audioRef.current;
      const video = videoRef.current;
      if (audio && video && video.src && ownerRef.current === "track" && !audio.paused) {
        try {
          if (Math.abs(video.currentTime - audio.currentTime) > 0.08) {
            video.currentTime = audio.currentTime;
          }
        } catch {
          /* seek-before-ready */
        }
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  const snapSilent = useCallback((position: number) => {
    const silent = silentRef.current;
    if (!silent || !Number.isFinite(silent.duration) || silent.duration <= 0) return 0;
    // Leave 1.2s of headroom so the 1-second rewind window never hits `ended`.
    const max = Math.max(0, silent.duration - 1.2);
    const pos = Math.min(Math.max(0, position), max);
    try {
      silent.currentTime = pos;
    } catch {
      /* ignore */
    }
    return pos;
  }, []);

  const ensureAnchorDuration = useCallback(
    async (trackDuration: number) => {
      const silent = silentRef.current;
      if (!silent) return;
      const target = Math.max(2, Number.isFinite(trackDuration) ? trackDuration : 2);
      if (silent.src && Math.abs(silentDurationRef.current - target) < 0.2) return;

      log(`building silent placeholder ${describeSilentWav(target)}`);
      const url = createSilentWavUrl(target);
      if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current);
      silentUrlRef.current = url;
      silent.loop = false;
      silent.src = url;
      silent.load();

      await new Promise<void>((resolve) => {
        const done = () => {
          silent.removeEventListener("loadedmetadata", done);
          resolve();
        };
        silent.addEventListener("loadedmetadata", done);
        window.setTimeout(done, 800);
      });

      silentDurationRef.current = silent.duration || target;
      setAnchorDuration(silentDurationRef.current);
      log(
        `placeholder ready ${silentDurationRef.current.toFixed(2)}s (track ${target.toFixed(2)}s)`
      );
    },
    [log]
  );

  const stopSilent = useCallback(() => {
    const silent = silentRef.current;
    if (!silent) return;
    ignoreSilentPauseRef.current = true;
    silent.pause();
    window.setTimeout(() => {
      ignoreSilentPauseRef.current = false;
    }, 50);
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) {
      log("play() aborted — audio element missing");
      return;
    }
    if (!audio.src) {
      const fallback = tracksRef.current[indexRef.current];
      if (!fallback) {
        log("play() aborted — playlist is empty");
        return;
      }
      audio.src = fallback.url;
      audio.load();
      pendingPlayRef.current = true;
      log("play() had no src — loaded current track, waiting for canplay");
      return;
    }

    if (handoffLockRef.current) return;
    handoffLockRef.current = true;

    try {
      setPlaybackAudioSession();

      // HANDOFF: placeholder must be fully stopped before the track starts,
      // otherwise iOS reports both durations on the lock-screen seek bar.
      if (anchorModeRef.current !== "always-on") {
        stopSilent();
      }
      if (ownerRef.current === "anchor") {
        try {
          audio.currentTime = frozenPosRef.current;
        } catch {
          /* ignore */
        }
      }

      const startTrack = async () => {
        await audio.play();
        // Video is display-only (paused, seek-framed). Playing it as well is
        // what used to make iOS treat this as a video session.
        const video = videoRef.current;
        if (video && video.src) {
          try {
            video.pause();
            video.currentTime = audio.currentTime;
          } catch {
            /* ignore */
          }
        }
      };

      try {
        if (audio.readyState < 2) {
          pendingPlayRef.current = true;
          audio.load();
          log("play() waiting for canplay");
          return;
        }
        await startTrack();
      } catch (err) {
        log(`play() rejected: ${err} — retrying in 150ms`);
        await delay(150);
        setPlaybackAudioSession();
        try {
          await startTrack();
        } catch (err2) {
          setIsPlaying(false);
          if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
          log(`play() retry failed: ${err2}`);
          return;
        }
      }

      pendingPlayRef.current = false;
      setOwner("track");
      setIsPlaying(true);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      publishPosition(audio.duration, audio.currentTime, 1);
      startVideoFrames();

      if (anchorModeRef.current === "always-on") {
        try {
          await silentRef.current?.play();
        } catch (err) {
          log(`always-on placeholder play() rejected: ${err}`);
        }
      }

      log("play() → track owns session");
    } finally {
      handoffLockRef.current = false;
    }
  }, [log, setOwner, startVideoFrames, stopSilent]);

  const pause = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (handoffLockRef.current) return;
    handoffLockRef.current = true;

    try {
      const pos = audio.currentTime;
      frozenPosRef.current = pos;

      ignoreTrackPauseRef.current = true;
      audio.pause();
      videoRef.current?.pause();
      stopRaf();
      window.setTimeout(() => {
        ignoreTrackPauseRef.current = false;
      }, 50);

      setIsPlaying(false);
      setCurrentTime(pos);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      publishPosition(durationRef.current || audio.duration, pos, 0);

      const mode = anchorModeRef.current;
      if (mode === "off") {
        setOwner("idle");
        stopSilent();
        log(`pause() → idle (anchor off) @ ${pos.toFixed(2)}s`);
        return;
      }

      if (mode === "always-on") {
        // Placeholder is already playing; just freeze our reported position.
        setOwner("anchor");
        log(`pause() → always-on placeholder keeps running @ ${pos.toFixed(2)}s`);
        return;
      }

      // HANDOFF: track is stopped, placeholder of the same length takes over
      // at the same playhead so iOS doesn't see a 2s duration or a jump.
      await ensureAnchorDuration(durationRef.current || audio.duration || 2);
      const silent = silentRef.current;
      if (!silent) {
        setOwner("idle");
        return;
      }
      const snapped = snapSilent(pos);
      frozenPosRef.current = snapped;
      setPlaybackAudioSession();
      try {
        await silent.play();
        setOwner("anchor");
        log(`pause() → placeholder hold @ ${snapped.toFixed(2)}s / ${silent.duration.toFixed(2)}s`);
      } catch (err) {
        setOwner("idle");
        log(`placeholder play() rejected on pause: ${err}`);
      }
      publishPosition(durationRef.current || silent.duration, snapped, 0);
    } finally {
      handoffLockRef.current = false;
    }
  }, [ensureAnchorDuration, log, setOwner, snapSilent, stopRaf, stopSilent]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) {
      log("togglePlay ignored — nothing loaded");
      return;
    }
    if (ownerRef.current === "track" && !audio.paused) {
      void pause();
    } else {
      void play();
    }
  }, [play, pause, log]);

  const seek = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const max = Number.isFinite(audio.duration) ? audio.duration : time;
      const clamped = Math.max(0, Math.min(time, max));
      audio.currentTime = clamped;
      frozenPosRef.current = clamped;
      if (videoRef.current && videoRef.current.src) {
        try {
          videoRef.current.currentTime = clamped;
        } catch {
          /* ignore */
        }
      }
      if (ownerRef.current === "anchor") {
        snapSilent(clamped);
      }
      setCurrentTime(clamped);
      publishPosition(
        durationRef.current || audio.duration,
        clamped,
        ownerRef.current === "track" ? 1 : 0
      );
    },
    [snapSilent]
  );

  const seekRelative = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const base = ownerRef.current === "anchor" ? frozenPosRef.current : audio.currentTime;
      seek(base + delta);
    },
    [seek]
  );

  const attachVideo = useCallback((url: string) => {
    const container = videoContainerRef.current;
    let video = videoRef.current;
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("webkit-playsinline", "true");
      video.setAttribute("playsinline", "true");
      video.preload = "auto";
      video.controls = false;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "contain";
      video.style.background = "#000";
      videoRef.current = video;
    }
    if (container && video.parentNode !== container) {
      container.innerHTML = "";
      container.appendChild(video);
    }
    if (video.src !== url) {
      video.src = url;
      video.load();
    }
    video.pause();
  }, []);

  const detachVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }, []);

  const loadIndex = useCallback(
    (index: number, autoplay: boolean) => {
      const list = tracksRef.current;
      if (list.length === 0) return;
      const nextIndex = ((index % list.length) + list.length) % list.length;
      const track = list[nextIndex];
      const audio = audioRef.current;
      if (!audio || !track) return;

      stopSilent();
      stopRaf();
      setOwner("idle");

      indexRef.current = nextIndex;
      setCurrentIndex(nextIndex);
      setCurrentTime(0);
      setDuration(0);
      durationRef.current = 0;
      frozenPosRef.current = 0;

      pendingPlayRef.current = autoplay;
      audio.src = track.url;
      audio.load();

      if (styleRef.current === "dual") {
        attachVideo(track.url);
      } else {
        detachVideo();
      }

      log(
        `loaded [${nextIndex + 1}/${list.length}] ${track.name}${autoplay ? " (will autoplay)" : ""}`
      );

      if (autoplay && audio.readyState >= 2) {
        void play();
      }
    },
    [attachVideo, detachVideo, play, log, setOwner, stopRaf, stopSilent]
  );

  const goToTrack = useCallback(
    (index: number) => {
      const shouldPlay = pendingPlayRef.current || ownerRef.current === "track";
      loadIndex(index, shouldPlay);
    },
    [loadIndex]
  );

  const nextTrack = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const current = indexRef.current;
    if (repeatRef.current === "one") {
      seek(0);
      void play();
      return;
    }
    if (current >= list.length - 1) {
      if (repeatRef.current === "all") {
        loadIndex(0, true);
      } else {
        void pause();
        seek(0);
        log("end of playlist");
      }
      return;
    }
    loadIndex(current + 1, true);
  }, [loadIndex, pause, play, seek, log]);

  const prevTrack = useCallback(() => {
    const audio = audioRef.current;
    const pos = ownerRef.current === "anchor" ? frozenPosRef.current : audio?.currentTime ?? 0;
    if (pos > 3) {
      seek(0);
      return;
    }
    const list = tracksRef.current;
    if (list.length === 0) return;
    const shouldPlay = ownerRef.current === "track";
    const current = indexRef.current;
    if (current <= 0) {
      if (repeatRef.current === "all") {
        loadIndex(list.length - 1, shouldPlay);
      } else {
        seek(0);
      }
      return;
    }
    loadIndex(current - 1, shouldPlay);
  }, [loadIndex, seek]);

  const addFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      if (!fileList) return;
      const files = Array.from(fileList).filter(
        (f) =>
          f.type.startsWith("audio/") ||
          f.type.startsWith("video/") ||
          /\.(mp4|m4a|mp3|wav|aac|mov|m4v|webm|ogg|flac)$/i.test(f.name)
      );
      if (files.length === 0) {
        log("no audio/video files in selection");
        return;
      }
      const created = files.map(createTrack);
      const wasEmpty = tracksRef.current.length === 0;
      const next = [...tracksRef.current, ...created];
      tracksRef.current = next;
      setTracks(next);
      log(`added ${created.length} track(s): ${created.map((t) => t.name).join(", ")}`);
      if (wasEmpty) loadIndex(0, false);
    },
    [loadIndex, log]
  );

  const removeTrack = useCallback(
    (id: string) => {
      const prev = tracksRef.current;
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return;
      URL.revokeObjectURL(prev[idx].url);
      const next = prev.filter((t) => t.id !== id);
      tracksRef.current = next;
      setTracks(next);
      const current = indexRef.current;
      if (next.length === 0) {
        stopSilent();
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        detachVideo();
        setIsPlaying(false);
        setOwner("idle");
        setCurrentIndex(0);
        setCurrentTime(0);
        setDuration(0);
        return;
      }
      if (idx === current) {
        loadIndex(Math.min(current, next.length - 1), ownerRef.current === "track");
      } else if (idx < current) {
        const newIndex = current - 1;
        indexRef.current = newIndex;
        setCurrentIndex(newIndex);
      }
    },
    [detachVideo, loadIndex, setOwner, stopSilent]
  );

  const clearPlaylist = useCallback(() => {
    tracksRef.current.forEach((t) => URL.revokeObjectURL(t.url));
    tracksRef.current = [];
    setTracks([]);
    indexRef.current = 0;
    setCurrentIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setOwner("idle");
    stopSilent();
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    detachVideo();
    log("playlist cleared");
  }, [detachVideo, log, setOwner, stopSilent]);

  const cycleRepeat = useCallback(() => {
    setRepeatMode((prev) => (prev === "off" ? "all" : prev === "all" ? "one" : "off"));
  }, []);

  // Persistent elements.
  useEffect(() => {
    const audio = document.createElement("audio");
    audio.preload = "auto";
    audio.controls = false;
    audio.setAttribute("playsinline", "true");
    audio.setAttribute("webkit-playsinline", "true");
    audio.setAttribute("x-webkit-airplay", "allow");
    hideOffscreen(audio);
    document.body.appendChild(audio);
    audioRef.current = audio;

    const silent = document.createElement("audio");
    silent.preload = "auto";
    silent.volume = 0.001; // not muted — iOS ignores muted elements for session-keep
    silent.setAttribute("playsinline", "true");
    silent.setAttribute("data-silent", "true");
    hideOffscreen(silent);
    document.body.appendChild(silent);
    silentRef.current = silent;

    const onTime = () => {
      if (ownerRef.current !== "track") return;
      setCurrentTime(audio.currentTime);
      publishPosition(audio.duration, audio.currentTime, 1);
    };
    const onLoaded = () => {
      const d = audio.duration;
      if (Number.isFinite(d) && d > 0) {
        setDuration(d);
        durationRef.current = d;
        publishPosition(d, audio.currentTime, ownerRef.current === "track" ? 1 : 0);
        // Pre-build the matching placeholder so pause handoff is instant.
        if (anchorModeRef.current !== "off") {
          void ensureAnchorDuration(d);
        }
      }
    };
    const onPlay = () => {
      if (ignoreTrackPauseRef.current) return;
      setIsPlaying(true);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    };
    const onPause = () => {
      if (ignoreTrackPauseRef.current) return;
      // An unexpected pause while we still want the track (iOS backgrounding a
      // video session, etc.) — if the user is in "playing" state, try to resume.
    };
    const onEnded = () => {
      if (ownerRef.current !== "track") return;
      log("track ended");
      const mode = repeatRef.current;
      const list = tracksRef.current;
      const idx = indexRef.current;
      if (mode === "one") {
        audio.currentTime = 0;
        void play();
        return;
      }
      if (idx < list.length - 1) {
        loadIndex(idx + 1, true);
        return;
      }
      if (mode === "all" && list.length > 0) {
        loadIndex(0, true);
        return;
      }
      void pause();
    };
    const onCanPlay = () => {
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        void play();
      }
    };
    const onError = () => {
      const err = audio.error;
      log(`audio error ${err?.code ?? "?"}: ${err?.message ?? "unknown"}`);
    };

    // Placeholder: rewind 1s after ~1s of playback so the playhead stays frozen
    // at the paused position. This is what keeps the lock-screen seek bar still.
    const onSilentTime = () => {
      setAnchorTime(silent.currentTime);
      if (ownerRef.current !== "anchor") return;
      const frozen = frozenPosRef.current;
      if (silent.currentTime - frozen >= 1) {
        snapSilent(frozen);
        log(`placeholder rewind → ${frozen.toFixed(2)}s`);
      }
      publishPosition(durationRef.current || silent.duration, frozen, 0);
    };
    const onSilentEnded = () => {
      if (ownerRef.current !== "anchor") return;
      snapSilent(frozenPosRef.current);
      silent.play().catch(() => {});
    };
    const onSilentPause = () => {
      if (ignoreSilentPauseRef.current) return;
      if (ownerRef.current === "anchor" && anchorModeRef.current === "handoff") {
        // iOS paused our placeholder (lock-screen pause tap). Keep the session
        // alive by starting it again — the user-facing state is already paused.
        setPlaybackAudioSession();
        silent.play().catch(() => {});
      }
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("durationchange", onLoaded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("error", onError);
    audio.addEventListener("seeked", () => {
      if (ownerRef.current === "track") {
        publishPosition(audio.duration, audio.currentTime, 1);
      }
    });

    silent.addEventListener("timeupdate", onSilentTime);
    silent.addEventListener("ended", onSilentEnded);
    silent.addEventListener("pause", onSilentPause);

    setPlaybackAudioSession();
    log("engine ready — handoff placeholder (duration-matched, exclusive owner)");

    return () => {
      stopRaf();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.remove();
      silent.pause();
      silent.removeAttribute("src");
      silent.load();
      silent.remove();
      if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current);
      audioRef.current = null;
      silentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const track = tracksRef.current[indexRef.current];
    if (!track) return;
    if (sessionStyle === "dual") attachVideo(track.url);
    else detachVideo();
  }, [sessionStyle, attachVideo, detachVideo]);

  useEffect(() => {
    const onVis = () => {
      log(`document.visibilityState -> ${document.visibilityState}`);
      const audio = audioRef.current;
      const silent = silentRef.current;
      if (document.visibilityState === "hidden") {
        videoRef.current?.pause();
        stopRaf();
        return;
      }
      // Back to foreground: restore whoever should own the session.
      if (ownerRef.current === "track" && audio && audio.paused && !audio.ended) {
        void play();
      } else if (ownerRef.current === "anchor" && silent && silent.paused) {
        silent.play().catch(() => {});
      }
      if (ownerRef.current === "track" && audio && !audio.paused) {
        startVideoFrames();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [log, play, startVideoFrames, stopRaf]);

  useEffect(() => {
    return () => {
      tracksRef.current.forEach((t) => URL.revokeObjectURL(t.url));
    };
  }, []);

  const currentTrack = tracks[currentIndex] ?? null;

  return {
    tracks,
    currentTrack,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    repeatMode,
    sessionStyle,
    anchorMode,
    sessionOwner,
    anchorTime,
    anchorDuration,
    frozenPosition: sessionOwner === "anchor" ? frozenPosRef.current : currentTime,
    logs,
    videoContainerRef,
    getAudio,
    play,
    pause,
    togglePlay,
    seek,
    seekRelative,
    nextTrack,
    prevTrack,
    goToTrack,
    addFiles,
    removeTrack,
    clearPlaylist,
    cycleRepeat,
    setSessionStyle,
    setAnchorMode,
    log,
    clearLogs: () => setLogs([]),
  };
}
