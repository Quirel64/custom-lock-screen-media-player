import { useState } from "react";
import MediaTestPlayer from "./components/MediaTestPlayer";
import MediaTestPlayerArena from "./components/MediaTestPlayerArena";
import MediaTestPlayerFreezeExact from "./components/MediaTestPlayerFreezeExact";

type ActiveMode = "anchor" | "freeze" | "arena";

export default function App() {
  const [mode, setMode] = useState<ActiveMode>("freeze");
  return (
    <div className="min-h-screen bg-[#05070a] text-white">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-emerald-400/80">
            iOS lock screen media session tester
          </p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Background playback &amp; lock screen UI debugger
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-white/60">
            Load an MP4 (video or audio), play it, then lock your phone or switch apps to
            see what the real iOS lock screen draws. Toggle below between{" "}
            <strong className="text-white/80">anchor handoff / single-element freeze</strong>,{" "}
            <strong className="text-sky-300">Freeze Exact (check it out — single-element rate 0)</strong> and{" "}
            <strong className="text-sky-300">Arena same-element (silent WAV swap, HOLD_RATE 0.25)</strong>.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => setMode("anchor")}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${mode === "anchor" ? "bg-emerald-500 text-white" : "bg-white/10 text-white/60 hover:bg-white/20"}`}
            >
              Anchor / Single (Plan 1)
            </button>
            <button
              onClick={() => setMode("freeze")}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${mode === "freeze" ? "bg-sky-500 text-white" : "bg-white/10 text-white/60 hover:bg-white/20"}`}
            >
              Freeze Exact (check it out)
            </button>
            <button
              onClick={() => setMode("arena")}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${mode === "arena" ? "bg-violet-500 text-white" : "bg-white/10 text-white/60 hover:bg-white/20"}`}
            >
              Arena same-element
            </button>
          </div>
          <p className="mt-2 text-xs text-white/40">
            <span className="text-emerald-300">Anchor</span>: two elements, silent WAV handoff.{" "}
            <span className="text-sky-300">Freeze Exact</span>: verbatim from `check it out` — single
            element keeps playing at rate 0 / vol 0.001, publishes playbackRate 0, pins via rAF+timeupdate, VideoSyncController nudge — fixes Windows stutter loop + iOS seek snap.{" "}
            <span className="text-violet-300">Arena</span>: one permanent &lt;audio&gt; swaps src track ↔ WAV, HOLD_RATE 0.25.
          </p>
        </header>

        {mode === "arena" ? (
          <MediaTestPlayerArena />
        ) : mode === "freeze" ? (
          <MediaTestPlayerFreezeExact />
        ) : (
          <MediaTestPlayer />
        )}

        <footer className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-relaxed text-white/60">
          {mode === "freeze" ? (
            <>
              <h2 className="mb-2 text-sm font-semibold text-white/80">
                Freeze Exact — verbatim from `check it out` (what this tab tests)
              </h2>
              <p className="mb-3">
                This is the <strong className="text-sky-300">single-element freeze</strong> that
                already fixes the Windows pause stutter loop. Freeze never calls{" "}
                <code className="text-sky-300">element.pause()</code> (pausing is what kills the
                PWA session and, on Windows, triggers the stutter loop). It keeps the SAME{" "}
                <code className="text-sky-300">&lt;audio&gt;</code> playing at{" "}
                <code className="text-sky-300">volume 0.001</code> +{" "}
                <code className="text-sky-300">playbackRate 0</code> and publishes{" "}
                <code className="text-sky-300">setPositionState(..., playbackRate: 0)</code>.
              </p>
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  <strong className="text-white/80">While frozen</strong> — rAF +{" "}
                  <code className="text-sky-300">timeupdate</code> pins{" "}
                  <code className="text-sky-300">currentTime = frozenPos</code> and re-publishes
                  rate 0 every frame. iOS equation{" "}
                  <code className="rounded bg-black/40 px-1 py-0.5 text-emerald-300">
                    displayed = lastPosition + (now-lastUpdate)*rate
                  </code>{" "}
                  stops, so the lock-screen bar does not creep while paused.
                </li>
                <li>
                  <strong className="text-white/80">On resume</strong> — seeks back to frozenPos,
                  waits for <code className="text-sky-300">seeked</code> before restoring rate 1,
                  then snap-corrects for ~3.5s if native time is still ahead. Next/prev keys off
                  track id only, so adding a 2nd file no longer reloads the current track.
                </li>
                <li>
                  <strong className="text-white/80">A/V sync</strong> — delegated to{" "}
                  <code className="text-emerald-300">VideoSyncController</code>: dead-band 0.08s,
                  nudge ±8% for drift ≤1.2s, one guarded seek with cooldown for larger drift —
                  eliminates the seek-storm stutter vs legacy seek-on-drift &gt;0.3s loop.
                </li>
              </ol>
              <p className="mt-3 text-xs text-sky-300/80">
                Exact copy of: <code>check it out/src/hooks/useFreezeEngine.ts</code>,{" "}
                <code>lib/videoSync.ts</code>, <code>hooks/useMediaSessionController.ts</code> (log-only),{" "}
                <code>components/VideoSurface.tsx</code> + <code>PlaylistPanel.tsx</code> and{" "}
                <code>MediaTestPlayer.tsx</code>. Only import paths were adjusted; logic is byte-for-byte identical (formatBytes added to lib/format.ts).
              </p>
            </>
          ) : mode === "arena" ? (
            <>
              <h2 className="mb-2 text-sm font-semibold text-white/80">Arena same-element</h2>
              <p>
                One permanent <code className="text-violet-300">&lt;audio&gt;</code> swaps{" "}
                <code className="text-violet-300">src</code> between the real track and a
                duration-matched silent WAV. HOLD_RATE 0.25, queued transitions — fixes PWA
                cross-element <code>AbortError</code> that breaks the two-element anchor in
                standalone mode.
              </p>
            </>
          ) : (
            <>
              <h2 className="mb-2 text-sm font-semibold text-white/80">
                Exclusive anchor handoff (what this build tests)
              </h2>
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  <strong className="text-white/80">While playing</strong> — only the real
                  track element is playing. The silent anchor is fully paused.{" "}
                  <code className="rounded bg-black/40 px-1 py-0.5 text-emerald-300">
                    setPositionState
                  </code>{" "}
                  reports the track. No competing timelines → no seek-bar snap.
                </li>
                <li>
                  <strong className="text-white/80">On pause</strong> — the track pauses. We
                  generate (or reuse) a silent WAV whose <em>duration matches the track</em>,
                  snap its <code className="text-emerald-300">currentTime</code> to the frozen
                  pause position, start it near-silently, and pin that position every animation
                  frame. iOS keeps seeing an active audio session, so lock-screen controls stay
                  alive and resume works. The seek bar stays put because the anchor's reported
                  duration equals the track and its playhead is frozen.
                </li>
                <li>
                  <strong className="text-white/80">On resume</strong> — anchor pauses (pin loop
                  stops), track starts again from the frozen position, ownership flips back.
                  Only one element is ever playing at a time.
                </li>
              </ol>
              <h2 className="mb-2 mt-5 text-sm font-semibold text-white/80">
                Why the always-on 2s loop fights the seek bar
              </h2>
              <p>
                When two media elements play at once, iOS merges them into one Media Session.
                The lock-screen seek bar then oscillates between the real track's timeline and
                the 2-second looping WAV. Matching the anchor's duration to the track + exclusive ownership removes the second timeline entirely while paused, and removes the anchor entirely while playing.
              </p>
            </>
          )}

          <h2 className="mb-2 mt-5 text-sm font-semibold text-white/80">Other lock-screen notes</h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white/80">Round "±10s" vs chevrons</strong> — controlled
              by which handlers you register:{" "}
              <code className="text-emerald-300">seekbackward/seekforward</code> → round
              arrows; <code className="text-emerald-300">previoustrack/nexttrack</code> →
              chevrons. Registering both is version-dependent.
            </li>
            <li>
              <strong className="text-white/80">Non-functional seek bar</strong> — needs a{" "}
              <code className="text-emerald-300">seekto</code> handler + frequent{" "}
              <code className="text-emerald-300">setPositionState()</code>, and works far
              more reliably when a <code className="text-emerald-300">&lt;video&gt;</code>{" "}
              participates in the session (dual mode).
            </li>
            <li>
              <strong className="text-white/80">Next/Previous needs a real playlist</strong>{" "}
              — the handlers only paint the buttons. Load 2+ files above before testing
              lock-screen track switching.
            </li>
          </ul>
          <p className="mt-3 text-xs text-white/40">
            Tip: test all three as a normal Safari tab and as an installed Home Screen PWA —
            standalone PWAs hit extra WebKit bugs (session going unresponsive after ~30s
            paused is bug 261858). Watch the owner badge and event log on every pause/resume.
          </p>
        </footer>
      </div>
    </div>
  );
}
