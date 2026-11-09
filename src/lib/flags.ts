/**
 * 27.x WebKit research flags — persisted in localStorage (survives force-close).
 *
 * Why these exist
 * ---------------
 * Between WebKit 26.2 (baseline) and 27.x, three Media/NowPlaying changes landed:
 *
 *  1. bug 305592 (305995@main, Jan 2026) — interruptions (system OR WebKit policy,
 *     which includes entering background) now dispatch the MediaSession "pause"
 *     action handler instead of just pausing the element. PlaybackState writes
 *     also gained native side effects: MediaSession now owns a PlatformMediaSession,
 *     so `playbackState = "playing"` calls clientWillBeginPlayback() and
 *     `"paused"` calls clientWillPausePlayback(). Declaring "paused" while the
 *     element is still silently producing (our freeze trick) is no longer inert.
 *
 *  2. Quirk `ShouldSuppressMediaSessionPauseActionOnInterruption` — Apple added a
 *     site-specific opt-OUT of the interruption pause action ("to steal audio
 *     session" protection after pages re-assert play during an interruption,
 *     see Tubular quirk bug 314264). Not exposed to JS.
 *
 *  3. bug 308083 (307778@main, Feb 2026) — the audio session category model now
 *     tracks `hasPlayedAudiblySinceLastInterruption`; an element that started
 *     playing MUTED could drop the shared session from MediaPlayback back to
 *     Ambient on pause. Muted mask video + rate-0 frozen audio live exactly here.
 *
 * Each flag attacks one of these hypotheses and is testable on-device one at a time.
 */

export type PlaybackStateMode = "standard" | "no-paused" | "untouched";
export type AudioSessionType = "playback" | "transient" | "unset";

export interface LockFlags {
  /**
   * How MediaSession.playbackState is written while the user-facing state is
   * "paused" (frozen element or silent anchor).
   *  standard  — declare the user-facing truth: "paused" while frozen/anchored.
   *              On the (outdated) freeze engine this is the pre-27 posture.
   *              On the Arena engine this matches the main media player's flow
   *              (anchor → playbackState=paused).
   *  no-paused — keep declaring "playing" while the element is still genuinely
   *              producing (silent WAV at HOLD_RATE in Arena; rate-0 in freeze).
   *              This is the posture the Arena engine shipped with on 26.2.
   *  untouched — playbackState is never written at all; the platform "guessed
   *              state" (spec-fallback from the element) rules.
   */
  playbackStateMode: PlaybackStateMode;
  /**
   * If ON: a MediaSession "pause" action while document.hidden AND frozen is
   * treated as the new WebKit interruption echo (bug 305592) and ignored,
   * instead of unfreezing (which calls play() during an interruption — the
   * documented audio-session-steal pattern).
   */
  echoGate: boolean;
  /**
   * If ON: on visibilitychange → hidden the muted <video> is torn down
   * (src removed) and re-armed on visible, so lock establishment happens with
   * a single media session — the no-decode alternative to video-delayed-start.
   */
  videoTeardown: boolean;
  /** navigator.audioSession.type: "playback" (default), "transient", or unset. */
  audioSessionType: AudioSessionType;
}

const STORAGE_KEY = "lock-flags-27x";

export const DEFAULT_FLAGS: LockFlags = {
  // "no-paused" preserves the posture the shipped Arena engine had (always
  // declaring "playing", even while the silent anchor holds), so the A/B
  // baseline is honest: the default IS build-1 behavior on the Arena tab.
  playbackStateMode: "no-paused",
  echoGate: false,
  videoTeardown: false,
  audioSessionType: "playback",
};

export function loadFlags(): LockFlags {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FLAGS };
    return { ...DEFAULT_FLAGS, ...(JSON.parse(raw) as Partial<LockFlags>) };
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function saveFlags(flags: LockFlags) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch {
    /* Safari private mode may refuse — flags then just live in the session */
  }
}

export function flagsSummary(flags: LockFlags): string {
  return `flags: playbackState=${flags.playbackStateMode} echoGate=${flags.echoGate ? 1 : 0} videoTeardown=${flags.videoTeardown ? 1 : 0} audioSession=${flags.audioSessionType}`;
}
