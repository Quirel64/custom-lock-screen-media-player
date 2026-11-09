import {
  type AudioSessionType,
  type HoldRate,
  type LockFlags,
  type PlaybackStateMode,
} from "../lib/flags";

export type FlagsEngineKind = "freeze" | "arena";

type Info = { label: string; description: string };

/**
 * Per-engine meaning of the shared `playbackStateMode` values:
 *  - freeze (outdated rate-0 engine): standard = the pre-27 posture.
 *  - arena (same-element engine, matches the media player): standard =
 *    declare "paused" while the silent anchor holds; no-paused = always
 *    "playing" = the shipped 26.2-tested posture.
 */
const PBSTATE_INFO: Record<FlagsEngineKind, Record<PlaybackStateMode, Info>> = {
  freeze: {
    standard: {
      label: "Standard (26.2-style)",
      description:
        'Frozen publishes playbackState "paused" + playbackRate 0 — the pre-27 posture. Hypothesis to test: since 27.x this write has native side effects (clientWillPausePlayback) while the element is still silently producing.',
    },
    "no-paused": {
      label: "Never declare paused",
      description:
        'Frozen publishes rate 0 but keeps declaring "playing" (element reality). Tests whether the native pause declaration wedges the 27.x lock session.',
    },
    untouched: {
      label: "Untouched (guessed state)",
      description:
        'Never writes playbackState at all; the platform\'s "guessed state" (element-derived, per spec fallback) rules the lock UI.',
    },
  },
  arena: {
    standard: {
      label: "Paused while anchor (media-player-like)",
      description:
        "While the silent anchor holds the frozen position, declare \"paused\" — this matches the main media player's documented flow (anchor → playbackState=paused). NOTE: the shipped Test-App build 1 always declared \"playing\"; this mode changes that.",
    },
    "no-paused": {
      label: "Always playing (shipped baseline)",
      description:
        "Keep declaring \"playing\" even while the silent anchor is the active source — the element genuinely produces silence at rate 1e-9, and this is exactly what the shipped 26.2-validated build did. Use this to reproduce build-1 behavior.",
    },
    untouched: {
      label: "Untouched (guessed state)",
      description:
        "Never writes playbackState at all; the platform's guessed state (derived from the actual element) rules. Cleanest read on who owns the icon.",
    },
  },
};

const AUDIO_SESSION_INFO: Record<AudioSessionType, Info> = {
  playback: {
    label: "playback",
    description:
      'navigator.audioSession.type = "playback" — long-form default, holds the session aggressively.',
  },
  transient: {
    label: "transient",
    description:
      'navigator.audioSession.type = "transient" — community-reported 27.x fix that lets another media source take over the lock screen cleanly',
  },
  unset: {
    label: "unset",
    description:
      "Never sets audioSession.type — leaves WebKit's UA default. There is no way to clear it back at runtime; a reload is needed to apply moving away from unset.",
  },
};

const HOLD_RATE_INFO: Record<HoldRate, Info> = {
  "1e-9": {
    label: "1e-9 (test app)",
    description:
      "The test app's shipped constant. Drift while frozen is astronomically slow (years per track). What build 1 used — keep for the honest baseline.",
  },
  "1e-7": {
    label: "1e-7 (main player)",
    description:
      "The main media player's shipped tweak: ~4 months of drift per second — still effectively frozen, but a REAL difference from the test app. Select this to make the anchor byte-comparable with the main player.",
  },
};

interface Props {
  flags: LockFlags;
  onChange: (flags: LockFlags) => void;
  kind: FlagsEngineKind;
}

export default function FlagsPanel({ flags, onChange, kind }: Props) {
  return (
    <div className="rounded-lg border border-violet-400/30 bg-violet-500/5 p-3">
      <p className="mb-1 text-xs font-semibold text-violet-200">
        27.x WebKit flags (persistent — survives force-close)
      </p>
      <p className="mb-3 text-[11px] leading-relaxed text-white/40">
        Targets the 26.2→27.x changes: interruptions now dispatch the
        &quot;pause&quot; action (WebKit bug 305592), playbackState writes have
        native side effects, and the audio-session category tracks muted playback
        (bug 308083). Test one flag at a time: play → lock → wait 30s → try the
        seek bar / ±10s / play-pause.
      </p>

      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[11px] font-medium text-white/60">playbackState discipline</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PBSTATE_INFO[kind]) as PlaybackStateMode[]).map((pm) => (
              <button
                key={pm}
                onClick={() => onChange({ ...flags, playbackStateMode: pm })}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                  flags.playbackStateMode === pm
                    ? "bg-violet-500 text-white"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {PBSTATE_INFO[kind][pm].label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            {PBSTATE_INFO[kind][flags.playbackStateMode].description}
          </p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium text-white/60">Interruption echo gate</p>
          <button
            onClick={() => onChange({ ...flags, echoGate: !flags.echoGate })}
            className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
              flags.echoGate
                ? "bg-emerald-500 text-white"
                : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {flags.echoGate ? "ON — hidden pause press ignored while user-paused" : "OFF"}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            While the page is hidden and the user-paused state holds (frozen
            element / silent anchor), a lock &quot;pause&quot; press can only be
            the new WebKit interruption echo — honoring it would call play()
            during an interruption (the documented audio-session steal, bug
            314264).
          </p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium text-white/60">Video teardown on lock</p>
          <button
            onClick={() => onChange({ ...flags, videoTeardown: !flags.videoTeardown })}
            className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
              flags.videoTeardown
                ? "bg-emerald-500 text-white"
                : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {flags.videoTeardown
              ? "ON — mask video stripped at hidden, re-armed at visible"
              : "OFF"}
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            Lock establishment then happens with a single media session — no muted
            second decoder, no element that &quot;started playing while muted&quot;
            in the new category model (bug 308083). No-decode replacement for
            video-delayed-start.
          </p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium text-white/60">audioSession.type</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(AUDIO_SESSION_INFO) as AudioSessionType[]).map((t) => (
              <button
                key={t}
                onClick={() => onChange({ ...flags, audioSessionType: t })}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                  flags.audioSessionType === t
                    ? "bg-amber-500 text-white"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {AUDIO_SESSION_INFO[t].label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            {AUDIO_SESSION_INFO[flags.audioSessionType].description}
          </p>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium text-white/60">Anchor hold rate</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(HOLD_RATE_INFO) as HoldRate[]).map((r) => (
              <button
                key={r}
                onClick={() => onChange({ ...flags, holdRate: r })}
                className={`rounded-lg px-3 py-2 text-xs font-medium transition ${
                  flags.holdRate === r
                    ? "bg-rose-500 text-white"
                    : "bg-white/10 text-white/70 hover:bg-white/20"
                }`}
              >
                {HOLD_RATE_INFO[r].label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            {HOLD_RATE_INFO[flags.holdRate].description}
          </p>
        </div>
      </div>
    </div>
  );
}
