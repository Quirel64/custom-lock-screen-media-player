/**
 * VideoSyncController — keeps a muted <video> locked to an <audio> clock
 * without stutter.
 *
 * The problem with "if drift > X then video.currentTime = audio.currentTime":
 *   - every seek forces a keyframe decode → visible hitch
 *   - iOS reports currentTime = target immediately, but the frame lands
 *     150–400ms later; audio kept moving, so drift is > X again → seek again.
 *     That is the seek storm you see as constant stuttering.
 *
 * What this does instead:
 *   dead-band   |drift| ≤ 0.08s   → rate 1.0, do nothing
 *   nudge zone  0.08 < |drift| ≤ 1.2s → playbackRate = 1 − drift·GAIN (clamped ±8%)
 *   hard zone   |drift| > 1.2s   → one precise seek with latency lead, then a
 *                                  cooldown so we don't re-evaluate mid-decode
 *
 * Extra guards:
 *   - never seek while video.seeking (stacked seeks = worst stutter)
 *   - never evaluate while readyState < HAVE_FUTURE_DATA (still buffering)
 *   - measure real landing error on `seeked` and adapt the seek lead
 *
 * Framework-agnostic: hand it getters and call start()/stop()/hardSync().
 */

export interface VideoSyncStats {
  drift: number; // seconds, + = video ahead of audio
  rate: number;
  seeks: number;
  nudges: number;
  lastAction: string;
  seekLead: number;
}

export interface VideoSyncOptions {
  getAudio: () => HTMLMediaElement | null;
  getVideo: () => HTMLVideoElement | null;
  /** Return true only when the track owns the session and audio is really playing. */
  isActive: () => boolean;
  /** "nudge" = new behaviour. "legacy-seek" reproduces the old seek-on-drift loop for A/B. */
  mode?: "nudge" | "legacy-seek";
  onStats?: (s: VideoSyncStats) => void;
  log?: (msg: string) => void;
  /** How often to evaluate (ms). 250 is plenty; rAF only schedules. */
  intervalMs?: number;
}

const DEAD_BAND = 0.15;
const HARD_THRESHOLD = 2.0;
const GAIN = 0.6; // faster lock: 0.3s drift ≈ 18% → clamped to 25%
const RATE_MIN = 0.75;
const RATE_MAX = 1.25;
const SEEK_COOLDOWN_MS = 900;
const LEGACY_THRESHOLD = 0.3;

export class VideoSyncController {
  raf = 0;
  lastEval = 0;
  cooldownUntil = 0;
  seekLead = 0.25; // adaptive: higher lead to centre -0.30 drift, was 0.12
  pendingSeekTarget: number | null = null;
  pendingSeekAt = 0;
  stats: VideoSyncStats = {
    drift: 0,
    rate: 1,
    seeks: 0,
    nudges: 0,
    lastAction: "idle",
    seekLead: 0.25,
  };
  boundSeeked = () => this.onSeeked();
  attachedVideo: HTMLVideoElement | null = null;
  opts: VideoSyncOptions

  constructor(opts: VideoSyncOptions) { this.opts = opts }

  setMode(mode: "nudge" | "legacy-seek") {
    this.opts.mode = mode;
    this.resetRate();
    this.emit(`mode → ${mode}`);
  }

  start() {
    this.stop();
    this.attach();
    const tick = (now: number) => {
      if (now - this.lastEval >= (this.opts.intervalMs ?? 250)) {
        this.lastEval = now;
        this.evaluate(now);
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.resetRate();
  }

  /** Force one precise resync now (after unfreeze / visibility / big scrub). */
  hardSync(reason: string) {
    const a = this.opts.getAudio();
    const v = this.opts.getVideo();
    if (!a || !v || !v.src) return;
    this.seekTo(v, a.currentTime, reason);
  }

  attach() {
    const v = this.opts.getVideo();
    if (v && v !== this.attachedVideo) {
      this.attachedVideo?.removeEventListener("seeked", this.boundSeeked);
      v.addEventListener("seeked", this.boundSeeked);
      this.attachedVideo = v;
    }
  }

  resetRate() {
    const v = this.opts.getVideo();
    if (v && v.playbackRate !== 1) {
      try {
        v.playbackRate = 1;
      } catch {
        /* ignore */
      }
    }
    this.stats.rate = 1;
  }

  emit(action: string) {
    this.stats.lastAction = action;
    this.stats.seekLead = this.seekLead;
    this.opts.onStats?.({ ...this.stats });
  }

  seekTo(v: HTMLVideoElement, audioTime: number, reason: string) {
    if (v.seeking) return;
    const target = audioTime + this.seekLead;
    try {
      v.currentTime = target;
      this.pendingSeekTarget = audioTime; // remember what we *wanted* to match
      this.pendingSeekAt = performance.now();
      this.cooldownUntil = performance.now() + SEEK_COOLDOWN_MS;
      this.stats.seeks += 1;
      try {
        v.playbackRate = 1;
      } catch {
        /* ignore */
      }
      this.stats.rate = 1;
      this.emit(`seek (${reason}) → ${target.toFixed(2)} lead ${this.seekLead.toFixed(2)}`);
    } catch {
      /* metadata not ready */
    }
  }

  onSeeked() {
    // Measure how far behind we actually landed and adapt the lead.
    const a = this.opts.getAudio();
    const v = this.opts.getVideo();
    if (!a || !v || this.pendingSeekTarget == null) return;
    const landedDrift = v.currentTime - a.currentTime; // negative = still behind
    const elapsed = (performance.now() - this.pendingSeekAt) / 1000;
    this.pendingSeekAt = 0;
    this.pendingSeekTarget = null;
    // If we landed behind, increase lead by half the error; if ahead, decrease.
    this.seekLead = Math.min(0.6, Math.max(0, this.seekLead - landedDrift * 0.5));
    this.stats.seekLead = this.seekLead;
    this.opts.log?.(
      `video seeked: landed ${landedDrift >= 0 ? "+" : ""}${landedDrift.toFixed(2)}s after ${elapsed.toFixed(2)}s → lead ${this.seekLead.toFixed(2)}`
    );
  }

  evaluate(now: number) {
    this.attach();
    const a = this.opts.getAudio();
    const v = this.opts.getVideo();
    if (!a || !v || !v.src) return;

    if (!this.opts.isActive()) {
      if (!v.paused) v.pause();
      this.resetRate();
      return;
    }

    if (v.paused) {
      v.play().catch(() => {});
      return;
    }

    // Don't judge drift while a seek is in flight or we're still buffering.
    if (v.seeking) return;
    if (v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    if (now < this.cooldownUntil) return;

    const drift = v.currentTime - a.currentTime;
    const abs = Math.abs(drift);
    this.stats.drift = drift;

    if ((this.opts.mode ?? "nudge") === "legacy-seek") {
      // Reproduces the old behaviour so you can feel the difference.
      if (abs > LEGACY_THRESHOLD) {
        try {
          v.currentTime = a.currentTime;
        } catch {
          /* ignore */
        }
        this.stats.seeks += 1;
        this.emit(`legacy seek drift ${drift.toFixed(2)}`);
      } else {
        this.emit("legacy ok");
      }
      return;
    }

    if (abs > HARD_THRESHOLD) {
      this.seekTo(v, a.currentTime, `drift ${drift.toFixed(2)}`);
      return;
    }

    if (abs > DEAD_BAND) {
      const rate = Math.min(RATE_MAX, Math.max(RATE_MIN, 1 - drift * GAIN));
      if (Math.abs(rate - v.playbackRate) > 0.005) {
        try {
          v.playbackRate = rate;
        } catch {
          /* ignore */
        }
        this.stats.nudges += 1;
      }
      this.stats.rate = rate;
      this.emit(`nudge ${rate.toFixed(3)} (drift ${drift.toFixed(2)})`);
      return;
    }

    if (v.playbackRate !== 1) {
      try {
        v.playbackRate = 1;
      } catch {
        /* ignore */
      }
    }
    this.stats.rate = 1;
    this.emit("locked");
  }
}
