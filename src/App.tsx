import MediaTestPlayer from "./components/MediaTestPlayer";

export default function App() {
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
            see what the real iOS lock screen draws. This build focuses on the{" "}
            <strong className="text-white/80">exclusive silent-anchor handoff</strong> —
            the fix for "pause then play doesn't resume" without the seek-bar snap you get
            when a looping 2s WAV runs alongside the track.
          </p>
        </header>

        <MediaTestPlayer />

        <footer className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-relaxed text-white/60">
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
            the 2-second looping WAV (your observation that "the seek bar shares the total
            time of the track with the .wav file" is exactly this). Matching the anchor's
            duration to the track + exclusive ownership removes the second timeline
            entirely while paused, and removes the anchor entirely while playing.
          </p>

          <h2 className="mb-2 mt-5 text-sm font-semibold text-white/80">
            Other lock-screen notes
          </h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white/80">Round "±10s" vs chevrons</strong> — controlled
              by which handlers you register:{" "}
              <code className="text-emerald-300">seekbackward/seekforward</code> → round
              arrows; <code className="text-emerald-300">previoustrack/nexttrack</code> →
              chevrons. Registering both (your repo currently does) is version-dependent.
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
            Tip: test both as a normal Safari tab and as an installed Home Screen PWA —
            standalone PWAs hit extra WebKit bugs (session going unresponsive after ~30s
            paused is bug 261858). Watch the owner badge and event log on every pause/resume.
          </p>
        </footer>
      </div>
    </div>
  );
}
