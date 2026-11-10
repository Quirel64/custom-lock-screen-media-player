import { addLog } from './logger'

/*
  Runtime experiment flags, localStorage-backed, toggled from the EventLog.
  Read AT CALL TIME (not module load) so an EventLog toggle takes effect
  immediately without re-applying handlers or reloading the app.
*/

const VIDEO_PAUSED_KEY = 'video-paused-mode'
const RESILIENT_KEY = 'lock-resilient-toggle'
const DELAYED_START_KEY = 'video-delayed-start'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const v = localStorage.getItem(key)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* ignore */ }
  return fallback
}

function writeFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, on ? '1' : '0') } catch { /* ignore */ }
}

// Experiment 1 → now DEFAULT: when ON, the muted <video> never plays — it
// stays paused and seek-framed. PROVEN on iOS 27.2: v.play() of the mask is
// THE poisoned-lock event (locks before a delayed start were healthy 10/10;
// after the video played, every lock wedged, flip-proof). Recovery from
// unlock↔lock needs the mode-flip revive (Experiment 3). In-app cost: video
// is a still frame with one drift-snap on return. Turn OFF (or use
// video-delayed-start) to trade lock safety for in-app motion.
export function isVideoPausedMode(): boolean {
  return readFlag(VIDEO_PAUSED_KEY, true)
}

export function setVideoPausedMode(on: boolean): void {
  writeFlag(VIDEO_PAUSED_KEY, on)
  addLog(`flag video-paused-mode → ${on ? 'ON' : 'OFF'} (takes effect on next video track load or seek)`)
}

// Experiment 2: the iOS 26.2 inverted-icon workaround. ON (default): lock-screen
// center presses route through the engine-aware remotePauseOrResume and pause()
// auto-resumes while anchor/pending. OFF: presses are literal (play→play,
// pause→pause, extra pauses ignored) — tests whether resuming against an
// interruption is what causes the pause/resume ping-pong + AbortError. Default ON.
export function isLockResilientToggle(): boolean {
  return readFlag(RESILIENT_KEY, true)
}

export function setLockResilientToggle(on: boolean): void {
  writeFlag(RESILIENT_KEY, on)
  addLog(`flag lock-resilient-toggle → ${on ? 'ON' : 'OFF'} (center presses: ${on ? 'engine-aware toggle' : 'literal play/pause'})`)
}

// Experiment 4: in-app video recovery. The lock wedge is born at session
// ESTABLISHMENT when the muted video is playing alongside (established-paused
// sessions stay healable by the mode-flip revive; established-dual-playing
// ones don't, and the seek bar specifically can't be rebound). When ON, the
// video is framed but stays paused for the first ~12s of a track so the
// session establishes on audio alone, then starts playing in-app. Never
// starts on a lock screen. Default OFF.
export function isVideoDelayedStart(): boolean {
  return readFlag(DELAYED_START_KEY, false)
}

export function setVideoDelayedStart(on: boolean): void {
  writeFlag(DELAYED_START_KEY, on)
  addLog(`flag video-delayed-start → ${on ? 'ON' : 'OFF'} (video starts playing 12s after track start; needs Video paused OFF)`)
}
// Experiment 3 (v2) → now DEFAULT: iOS builds the lock-screen UI from the
// registered handler set AT LOCK TIME. Same-set re-applies are proven inert
// (greyed and working runs emit identical re-applies) and no-flip sessions
// heal only randomly — a CONFIGURATION change rebuilds it deterministically:
// the handlers flip to the other lock mode then restore
// (useMediaSession.reviveHandlers) the instant visibility goes hidden.
const REVIVE_KEY = 'lock-revive-on-hidden'
export function isLockReviveOnHidden(): boolean {
  return readFlag(REVIVE_KEY, true)
}

export function setLockReviveOnHidden(on: boolean): void {
  writeFlag(REVIVE_KEY, on)
  addLog(`flag lock-revive-on-hidden → ${on ? 'ON' : 'OFF'} (handlers re-applied right before lock builds the UI)`)
}

// Tunable gap between the flip and the restore inside reviveHandlers. iOS
// needs both sets to land; if greyed controls ever slip through, try longer.
const REVIVE_DELAY_KEY = 'lock-revive-delay'
export function getLockReviveDelay(): number {
  try {
    const v = localStorage.getItem(REVIVE_DELAY_KEY)
    const n = v ? parseInt(v, 10) : NaN
    if (Number.isFinite(n) && n >= 0) return n
  } catch { /* ignore */ }
  return 300
}

export function setLockReviveDelay(ms: number): void {
  try { localStorage.setItem(REVIVE_DELAY_KEY, String(ms)) } catch { /* ignore */ }
  addLog(`flag lock-revive-delay → ${ms}ms (takes effect on next hidden)`)
}

// Experiment 5 → now DEFAULT: handler-application hygiene. Under the proven
// snapshot model the per-track-change same-set re-apply + null-cleanup only
// churned iOS's snapshot; device runs with this OFF the correct handler set
// appeared only stochastically, with this ON 15/15 — AND dual-play locks
// stopped wedging (the dead-zone saga's other proven "poison" was a cofactor
// of churn). Boot, mode toggles, play-start edge and the hidden flip still
// apply. A/B'd against lock-revive-on-hidden.
const MINIMAL_KEY = 'minimal-handlers'
export function isMinimalHandlers(): boolean {
  return readFlag(MINIMAL_KEY, true)
}

export function setMinimalHandlers(on: boolean): void {
  writeFlag(MINIMAL_KEY, on)
  addLog(`flag minimal-handlers → ${on ? 'ON' : 'OFF'} (skip same-set re-applies at track change; boot/mode-toggle/play-start/flip still apply)`)
}

// Experiment 6: echo-aware resilient toggle. The one hard problem left with
// resilient ON: an interruption (e.g. YouTube taking over) arrives as a rapid
// pause press PAIR — first press pauses us legitimately, the echo press within
// the same second re-asserts our track (ping-pong). v2 rules: (1) rapid-pair —
// a pause press within ~600ms of our own pause is the echo (human re-presses
// land ≥1s later); (2) external-evidence — a pause press within 4s of an
// external native pause (device logs show the external event is usually
// swallowed by the swap's transition guard, so rule 1 is the workhorse).
// Play presses are never gated. Default OFF.
const ECHO_AWARE_KEY = 'echo-aware-toggle'
export function isEchoAwareToggle(): boolean {
  return readFlag(ECHO_AWARE_KEY, false)
}

export function setEchoAwareToggle(on: boolean): void {
  writeFlag(ECHO_AWARE_KEY, on)
  addLog(`flag echo-aware-toggle → ${on ? 'ON' : 'OFF'} (v2: rapid-pair <600ms + external evidence <4s gate pause-press resumes)`)
}

// Experiment 7: lock warm-cycle. Device-proven: an autoplay (track end →
// auto-next) during a lock hands iOS a native pause→fresh play pair and the
// lock UI comes up FULLY WARM — correct icons, live touch routing, working
// seek bar, single presses; the cold-lock symptoms (icon flip, dead handlers
// until first pause/unpause, triple press) all vanish. Reproduce that pair
// programmatically on every visible→hidden: pause the playing track,
// resume it ~700ms later on the same src (no swap, element stays activated).
const WARM_KEY = 'lock-warm-cycle'
export function isLockWarmCycle(): boolean {
  return readFlag(WARM_KEY, false)
}

export function setLockWarmCycle(on: boolean): void {
  writeFlag(WARM_KEY, on)
  addLog(`flag lock-warm-cycle → ${on ? 'ON' : 'OFF'} (synthetic pause→play pair on every hidden, mimics the autoplay warm-up)`)
}

// Tunable warm-gap (EventLog cycler). 700ms proven; shorter gaps may not warm.
const WARM_DELAY_KEY = 'lock-warm-cycle-delay'
const DEFAULT_WARM_DELAY_MS = 700
export function getWarmCycleDelay(): number {
  try {
    const v = parseInt(localStorage.getItem(WARM_DELAY_KEY) || '', 10)
    if (v === 200 || v === 450 || v === 700) return v
  } catch { /* ignore */ }
  return DEFAULT_WARM_DELAY_MS
}

export function setWarmCycleDelay(ms: number): void {
  try { localStorage.setItem(WARM_DELAY_KEY, String(ms)) } catch { /* ignore */ }
  addLog(`flag lock-warm-cycle-delay → ${ms}ms (next lock uses the new gap)`)
}
