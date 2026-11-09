import { useCallback, useEffect, useRef, useState } from "react";
import { createSilentWavUrl, describeSilentWav } from "../lib/silentAudio.arena";
import { delay, setPlaybackAudioSession } from "../lib/audioSession.arena";
import {
  createTrack,
  type AnchorMode,
  type PlaylistTrack,
  type RepeatMode,
  type SessionOwner,
  type SessionStyle,
} from "../lib/types.arena";

type SourceKind = "track" | "anchor";
type Command = "play" | "pause";

// Safari accepts this as real playback while keeping unavoidable anchor drift
// small. Timers are not guaranteed while a standalone PWA is hidden, so
// correctness cannot depend on the rewind firing.
const HOLD_RATE = 0.000000001;

function hideOffscreen(el: HTMLElement) {
  el.style.position = "fixed";
  el.style.left = "-8px";
  el.style.top = "-8px";
  el.style.width = "1px";
  el.style.height = "1px";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
}

function mediaError(error: MediaError | null): string {
  if (!error) return "unknown media error";
  return `code ${error.code}${error.message ? `: ${error.message}` : ""}`;
}

function publishPosition(duration: number, position: number, playbackRate: number) {
  if (!("mediaSession" in navigator)) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate,
      position: Math.min(Math.max(0, position), duration),
    });
  } catch {
    /* iOS can reject position state during a source transition */
  }
}

/**
 * One-element iOS handoff engine.
 *
 * iOS grants background playback permission per HTMLMediaElement. Safari is
 * willing to wake element A after element B took over, but a home-screen PWA
 * often rejects or silently ignores that cross-element play(). Therefore this
 * engine creates exactly one permanent <audio> and never replaces it:
 *
 *   play   -> audio.src = real track
 *   pause  -> same audio.src = duration-matched silent WAV
 *   resume -> same audio.src = real track, restored to frozen currentTime
 *
 * The source swap and play() request happen synchronously in the MediaSession
 * action callback. We do not await metadata before calling play(); doing so
 * loses iOS's remote-control activation in standalone mode.
 */
export function usePlaybackEngine() {
  const mediaRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const anchorUrlRef = useRef("");
  const anchorForDurationRef = useRef(0);

  const tracksRef = useRef<PlaylistTrack[]>([]);
  const indexRef = useRef(0);
  const repeatRef = useRef<RepeatMode>("all");
  const styleRef = useRef<SessionStyle>("audio-only");
  const anchorModeRef = useRef<AnchorMode>("handoff");
  const ownerRef = useRef<SessionOwner>("idle");
  const sourceKindRef = useRef<SourceKind>("track");
  const frozenPosRef = useRef(0);
  const trackDurationRef = useRef(0);
  const transitionRef = useRef(false);
  const transitionTokenRef = useRef(0);
  const queuedCommandRef = useRef<Command | null>(null);
  const commandRunnerRef = useRef<((command: Command) => void) | null>(null);
  const rafRef = useRef(0);

  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("all");
  const [sessionStyle, setSessionStyle] = useState<SessionStyle>("audio-only");
  const [anchorMode, setAnchorModeState] = useState<AnchorMode>("handoff");
  const [sessionOwner, setSessionOwner] = useState<SessionOwner>("idle");
  const [anchorTime, setAnchorTime] = useState(0);
  const [anchorDuration, setAnchorDuration] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  tracksRef.current = tracks;
  indexRef.current = currentIndex;
  repeatRef.current = repeatMode;
  styleRef.current = sessionStyle;
  anchorModeRef.current = anchorMode;
  trackDurationRef.current = duration;

  const log = useCallback((message: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-299), `[${time}] ${message}`]);
  }, []);

  const setOwner = useCallback((owner: SessionOwner) => {
    ownerRef.current = owner;
    setSessionOwner(owner);
  }, []);

  const getAudio = useCallback(() => mediaRef.current, []);

  const stopRaf = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const startVideoFrames = useCallback(() => {
    stopRaf();
    const tick = () => {
      const media = mediaRef.current;
      const video = videoRef.current;
      if (
        media &&
        video &&
        video.src &&
        sourceKindRef.current === "track" &&
        ownerRef.current === "track" &&
        !media.paused
      ) {
        try {
          if (Math.abs(video.currentTime - media.currentTime) > 0.08) {
            video.currentTime = media.currentTime;
          }
        } catch {
          /* video metadata may not be ready */
        }
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  const attachVideo = useCallback((url: string) => {
    let video = videoRef.current;
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("webkit-playsinline", "true");
      video.preload = "metadata";
      video.controls = false;
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "contain";
      video.style.background = "#000";
      videoRef.current = video;
    }
    const container = videoContainerRef.current;
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

  const ensureAnchor = useCallback(
    (trackDuration: number) => {
      const target = Math.max(2, Number.isFinite(trackDuration) ? trackDuration : 2);
      if (anchorUrlRef.current && Math.abs(anchorForDurationRef.current - target) < 0.2) {
        return;
      }

      log(`building same-element placeholder ${describeSilentWav(target)}`);
      const nextUrl = createSilentWavUrl(target);
      const previousUrl = anchorUrlRef.current;
      anchorUrlRef.current = nextUrl;
      anchorForDurationRef.current = target;
      setAnchorDuration(target);
      // Never revoke a Blob while it is the permanent element's active src.
      if (previousUrl && sourceKindRef.current !== "anchor") {
        URL.revokeObjectURL(previousUrl);
      }
    },
    [log]
  );

  const flushQueuedCommand = useCallback(() => {
    const command = queuedCommandRef.current;
    queuedCommandRef.current = null;
    if (command) queueMicrotask(() => commandRunnerRef.current?.(command));
  }, []);

  /** Swap the source and request playback before the first await. */
  const activateSource = useCallback(
    async (kind: SourceKind, url: string, position: number) => {
      const media = mediaRef.current;
      if (!media || !url) throw new Error("media element or source missing");

      const token = ++transitionTokenRef.current;
      sourceKindRef.current = kind;
      setOwner("idle");
      setPlaybackAudioSession();

      const rate = kind === "anchor" ? HOLD_RATE : 1;
      const setPositionWhenReady = () => {
        if (token !== transitionTokenRef.current) return;
        const sourceDuration = media.duration;
        const safeMax = Number.isFinite(sourceDuration)
          ? Math.max(0, sourceDuration - 0.35)
          : position;
        const safePosition = Math.min(Math.max(0, position), safeMax);
        try {
          media.currentTime = safePosition;
        } catch {
          /* canplay will try again */
        }
        media.defaultPlaybackRate = rate;
        media.playbackRate = rate;
        if (kind === "anchor") {
          setAnchorDuration(media.duration || anchorForDurationRef.current);
          setAnchorTime(safePosition);
        }
      };

      media.addEventListener("loadedmetadata", setPositionWhenReady, { once: true });
      media.addEventListener("canplay", setPositionWhenReady, { once: true });
      media.autoplay = true;
      media.defaultPlaybackRate = rate;
      media.playbackRate = rate;
      media.src = url;
      media.load();

      // Must be invoked in the direct UI/MediaSession callback stack.
      const playPromise = media.play();
      await playPromise;

      if (token !== transitionTokenRef.current) return;
      setPositionWhenReady();
      setOwner(kind);
      if (kind === "track") {
        setIsPlaying(true);
        publishPosition(media.duration || trackDurationRef.current, media.currentTime, 1);
        startVideoFrames();
      } else {
        setIsPlaying(false);
        publishPosition(
          trackDurationRef.current || media.duration,
          frozenPosRef.current,
          media.playbackRate || HOLD_RATE
        );
      }
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      log(`${kind} source active on permanent element @ ${media.currentTime.toFixed(2)}s`);
    },
    [log, setOwner, startVideoFrames]
  );

  const play = useCallback(async () => {
    const track = tracksRef.current[indexRef.current];
    const media = mediaRef.current;
    if (!track || !media) {
      log("play ignored — no track loaded");
      return;
    }
    if (transitionRef.current) {
      queuedCommandRef.current = "play";
      log("play queued behind source swap");
      return;
    }
    transitionRef.current = true;

    try {
      const resumePosition = frozenPosRef.current;
      if (sourceKindRef.current === "track" && media.src === track.url) {
        setPlaybackAudioSession();
        if (Number.isFinite(resumePosition)) media.currentTime = resumePosition;
        // Called before await so iOS keeps the activation.
        const directPlay = media.play();
        await directPlay;
        setOwner("track");
        setIsPlaying(true);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        publishPosition(media.duration, media.currentTime, 1);
        startVideoFrames();
        log(`track resumed on permanent element @ ${media.currentTime.toFixed(2)}s`);
      } else {
        try {
          await activateSource("track", track.url, resumePosition);
        } catch (error) {
          log(`track source swap play() failed: ${error}`);
          await delay(120);
          await activateSource("track", track.url, resumePosition);
        }
      }
    } catch (error) {
      setIsPlaying(false);
      setOwner("idle");
      log(`resume failed on permanent element: ${error}`);
    } finally {
      transitionRef.current = false;
      flushQueuedCommand();
    }
  }, [activateSource, flushQueuedCommand, log, setOwner, startVideoFrames]);

  const pause = useCallback(async () => {
    const media = mediaRef.current;
    if (!media) return;
    if (sourceKindRef.current === "anchor") {
      // iOS still shows || because the placeholder is genuinely playing.
      log("pause command while placeholder active → resume track");
      void play();
      return;
    }
    if (transitionRef.current) {
      queuedCommandRef.current = "pause";
      log("pause queued behind source swap");
      return;
    }
    transitionRef.current = true;

    try {
      const position = media.currentTime;
      frozenPosRef.current = position;
      setCurrentTime(position);
      setIsPlaying(false);
      stopRaf();

      if (anchorModeRef.current === "off") {
        media.pause();
        setOwner("idle");
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        publishPosition(trackDurationRef.current || media.duration, position, 1);
        log(`paused without placeholder @ ${position.toFixed(2)}s`);
        return;
      }

      // Synchronous by design: activateSource/play() must remain in the direct
      // MediaSession action stack in standalone iOS.
      ensureAnchor(trackDurationRef.current || media.duration || 2);
      await activateSource("anchor", anchorUrlRef.current, position);
      log(`track → placeholder source swap complete @ ${position.toFixed(2)}s`);
    } catch (error) {
      setOwner("idle");
      log(`placeholder source swap failed: ${error}`);
    } finally {
      transitionRef.current = false;
      flushQueuedCommand();
    }
  }, [activateSource, ensureAnchor, flushQueuedCommand, log, play, setOwner, stopRaf]);

  commandRunnerRef.current = (command) => {
    if (command === "play") void play();
    else void pause();
  };

  const togglePlay = useCallback(() => {
    if (ownerRef.current === "track") void pause();
    else void play();
  }, [pause, play]);

  const remotePlay = useCallback(() => {
    log(`remote play (source=${sourceKindRef.current}, owner=${ownerRef.current})`);
    void play();
  }, [log, play]);

  const remotePause = useCallback(() => {
    log(`remote pause (source=${sourceKindRef.current}, owner=${ownerRef.current})`);
    void pause();
  }, [log, pause]);

  const seek = useCallback(
    (time: number) => {
      const media = mediaRef.current;
      if (!media) return;
      const trackDuration = trackDurationRef.current || media.duration || time;
      const clamped = Math.max(0, Math.min(time, trackDuration));
      frozenPosRef.current = clamped;
      setCurrentTime(clamped);

      const sourceMax = Number.isFinite(media.duration)
        ? Math.max(0, media.duration - 0.35)
        : clamped;
      try {
        media.currentTime = Math.min(clamped, sourceMax);
        if (sourceKindRef.current === "anchor") setAnchorTime(media.currentTime);
      } catch {
        /* ignore */
      }

      const video = videoRef.current;
      if (video?.src) {
        try {
          video.currentTime = clamped;
        } catch {
          /* ignore */
        }
      }
      publishPosition(
        trackDuration,
        clamped,
        sourceKindRef.current === "track" ? 1 : media.playbackRate || HOLD_RATE
      );
      log(`seek ${clamped.toFixed(2)}s (source=${sourceKindRef.current})`);
    },
    [log]
  );

  const seekRelative = useCallback(
    (delta: number) => seek(frozenPosRef.current + delta),
    [seek]
  );

  const loadIndex = useCallback(
    (index: number, autoplay: boolean) => {
      const list = tracksRef.current;
      const media = mediaRef.current;
      if (!media || list.length === 0) return;
      const nextIndex = ((index % list.length) + list.length) % list.length;
      const track = list[nextIndex];

      transitionTokenRef.current += 1;
      sourceKindRef.current = "track";
      setOwner("idle");
      setIsPlaying(false);
      setCurrentIndex(nextIndex);
      indexRef.current = nextIndex;
      frozenPosRef.current = 0;
      setCurrentTime(0);
      setDuration(0);
      trackDurationRef.current = 0;

      media.autoplay = autoplay;
      media.defaultPlaybackRate = 1;
      media.playbackRate = 1;
      media.src = track.url;
      media.load();

      if (styleRef.current === "dual") attachVideo(track.url);
      else detachVideo();

      log(`loaded [${nextIndex + 1}/${list.length}] ${track.name}${autoplay ? " (autoplay)" : ""}`);
      if (autoplay) void play();
    },
    [attachVideo, detachVideo, log, play, setOwner]
  );

  const goToTrack = useCallback(
    (index: number) => loadIndex(index, ownerRef.current === "track"),
    [loadIndex]
  );

  const nextTrack = useCallback(() => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    if (repeatRef.current === "one") {
      frozenPosRef.current = 0;
      seek(0);
      void play();
      return;
    }
    const next = indexRef.current + 1;
    if (next < list.length) loadIndex(next, true);
    else if (repeatRef.current === "all") loadIndex(0, true);
    else void pause();
  }, [loadIndex, pause, play, seek]);

  const prevTrack = useCallback(() => {
    if (frozenPosRef.current > 3) {
      seek(0);
      return;
    }
    const list = tracksRef.current;
    if (list.length === 0) return;
    const prev = indexRef.current - 1;
    if (prev >= 0) loadIndex(prev, ownerRef.current === "track");
    else if (repeatRef.current === "all") {
      loadIndex(list.length - 1, ownerRef.current === "track");
    } else seek(0);
  }, [loadIndex, seek]);

  const addFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      if (!fileList) return;
      const files = Array.from(fileList).filter(
        (file) =>
          file.type.startsWith("audio/") ||
          file.type.startsWith("video/") ||
          /\.(mp4|m4a|mp3|wav|aac|mov|m4v|webm|ogg|flac)$/i.test(file.name)
      );
      if (files.length === 0) {
        log("selection had no playable files");
        return;
      }
      const created = files.map(createTrack);
      const wasEmpty = tracksRef.current.length === 0;
      const next = [...tracksRef.current, ...created];
      tracksRef.current = next;
      setTracks(next);
      log(`added ${created.length} track(s): ${created.map((item) => item.name).join(", ")}`);
      if (wasEmpty) loadIndex(0, false);
    },
    [loadIndex, log]
  );

  const removeTrack = useCallback(
    (id: string) => {
      const list = tracksRef.current;
      const removeIndex = list.findIndex((item) => item.id === id);
      if (removeIndex < 0) return;
      URL.revokeObjectURL(list[removeIndex].url);
      const next = list.filter((item) => item.id !== id);
      tracksRef.current = next;
      setTracks(next);
      if (next.length === 0) {
        const media = mediaRef.current;
        media?.pause();
        media?.removeAttribute("src");
        media?.load();
        setOwner("idle");
        setIsPlaying(false);
        setCurrentIndex(0);
        setCurrentTime(0);
        setDuration(0);
        detachVideo();
      } else if (removeIndex === indexRef.current) {
        loadIndex(Math.min(removeIndex, next.length - 1), ownerRef.current === "track");
      } else if (removeIndex < indexRef.current) {
        indexRef.current -= 1;
        setCurrentIndex(indexRef.current);
      }
    },
    [detachVideo, loadIndex, setOwner]
  );

  const clearPlaylist = useCallback(() => {
    tracksRef.current.forEach((track) => URL.revokeObjectURL(track.url));
    tracksRef.current = [];
    setTracks([]);
    const media = mediaRef.current;
    media?.pause();
    media?.removeAttribute("src");
    media?.load();
    setOwner("idle");
    setIsPlaying(false);
    setCurrentIndex(0);
    setCurrentTime(0);
    setDuration(0);
    detachVideo();
    log("playlist cleared");
  }, [detachVideo, log, setOwner]);

  const cycleRepeat = useCallback(() => {
    setRepeatMode((value) => (value === "off" ? "all" : value === "all" ? "one" : "off"));
  }, []);

  const setAnchorMode = useCallback(
    (value: AnchorMode) => {
      anchorModeRef.current = value;
      setAnchorModeState(value);
      if (value === "off" && sourceKindRef.current === "anchor") {
        const media = mediaRef.current;
        media?.pause();
        setOwner("idle");
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
      }
    },
    [setOwner]
  );

  // The one audio element is created once and remains in the DOM for the
  // app's lifetime. controls=true helps iOS classify it as user media.
  useEffect(() => {
    const media = document.createElement("audio");
    media.preload = "auto";
    media.controls = true;
    media.setAttribute("playsinline", "true");
    media.setAttribute("webkit-playsinline", "true");
    media.setAttribute("x-webkit-airplay", "allow");
    media.dataset.sessionOwner = "permanent";
    hideOffscreen(media);
    document.body.appendChild(media);
    mediaRef.current = media;

    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone =
      nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    log(
      `environment: ${standalone ? "home-screen standalone PWA" : "browser tab"}; permanent element id initialized`
    );

    const onLoadedMetadata = () => {
      if (sourceKindRef.current === "anchor") {
        setAnchorDuration(media.duration || anchorForDurationRef.current);
        return;
      }
      const nextDuration = media.duration;
      if (!Number.isFinite(nextDuration) || nextDuration <= 0) return;
      trackDurationRef.current = nextDuration;
      setDuration(nextDuration);
      publishPosition(nextDuration, media.currentTime, 1);
      if (anchorModeRef.current === "handoff") ensureAnchor(nextDuration);
    };

    const onPlaying = () => {
      const kind = sourceKindRef.current;
      setOwner(kind);
      if (kind === "track") {
        setIsPlaying(true);
        startVideoFrames();
      } else {
        setIsPlaying(false);
      }
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
      log(`native playing event (${kind}, same element)`);
    };

    const onPause = () => {
      if (transitionRef.current) return;
      if (sourceKindRef.current === "track" && ownerRef.current === "track") {
        setIsPlaying(false);
      }
      log(`native pause event (${sourceKindRef.current})`);
    };

    const onTimeUpdate = () => {
      if (sourceKindRef.current === "track") {
        frozenPosRef.current = media.currentTime;
        setCurrentTime(media.currentTime);
        publishPosition(media.duration, media.currentTime, 1);
        return;
      }

      setAnchorTime(media.currentTime);
      // Best effort only: standalone iOS may suspend this callback. The frozen
      // track position remains authoritative even if the native anchor bar drifts.
      const frozen = frozenPosRef.current;
      if (media.currentTime - frozen >= 0.35) {
        try {
          media.currentTime = Math.min(frozen, Math.max(0, media.duration - 0.35));
        } catch {
          /* ignore */
        }
      }
      publishPosition(
        trackDurationRef.current || media.duration,
        frozen,
        media.playbackRate || HOLD_RATE
      );
    };

    const onEnded = () => {
      if (sourceKindRef.current === "anchor") {
        const safe = Math.max(0, Math.min(frozenPosRef.current, media.duration - 0.35));
        media.currentTime = safe;
        media.play().catch((error) => log(`placeholder restart failed: ${error}`));
        return;
      }
      nextTrack();
    };

    const onError = () => log(`permanent media error: ${mediaError(media.error)}`);
    const onStalled = () => log(`permanent media stalled (${sourceKindRef.current})`);
    const onSuspend = () => log(`permanent media suspend (${sourceKindRef.current})`);

    media.addEventListener("loadedmetadata", onLoadedMetadata);
    media.addEventListener("durationchange", onLoadedMetadata);
    media.addEventListener("playing", onPlaying);
    media.addEventListener("pause", onPause);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("ended", onEnded);
    media.addEventListener("error", onError);
    media.addEventListener("stalled", onStalled);
    media.addEventListener("suspend", onSuspend);

    setPlaybackAudioSession();
    log("permanent audio element ready (same-element source handoff)");

    return () => {
      stopRaf();
      transitionTokenRef.current += 1;
      media.pause();
      media.removeAttribute("src");
      media.load();
      media.remove();
      mediaRef.current = null;
      if (anchorUrlRef.current) URL.revokeObjectURL(anchorUrlRef.current);
    };
    // Persistent element must never be recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const track = tracksRef.current[indexRef.current];
    if (!track) return;
    if (sessionStyle === "dual") attachVideo(track.url);
    else detachVideo();
  }, [sessionStyle, attachVideo, detachVideo]);

  // Reassert Safari's playback category whenever the PWA is restored. Do not
  // recreate the permanent element or change its source here.
  useEffect(() => {
    const onVisible = () => {
      log(`document.visibilityState -> ${document.visibilityState}`);
      if (document.visibilityState === "hidden") {
        stopRaf();
        videoRef.current?.pause();
        return;
      }
      setPlaybackAudioSession();
      const media = mediaRef.current;
      if (ownerRef.current === "track" && media && !media.paused) startVideoFrames();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      setPlaybackAudioSession();
      log(`pageshow${event.persisted ? " (bfcache)" : ""}`);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [log, startVideoFrames, stopRaf]);

  useEffect(() => {
    return () => tracksRef.current.forEach((track) => URL.revokeObjectURL(track.url));
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
    frozenPosition: frozenPosRef.current,
    logs,
    videoContainerRef,
    getAudio,
    play,
    pause,
    remotePlay,
    remotePause,
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