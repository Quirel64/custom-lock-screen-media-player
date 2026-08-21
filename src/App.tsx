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
            Handoff pause-hold debugger
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-white/60">
            Play a track, pause it, lock the phone, then press play on the lock
            screen. The silent placeholder should hold the iOS session while
            you&apos;re paused — without stealing the seek bar — and hand the
            session back to the track on resume.
          </p>
        </header>

        <MediaTestPlayer />

        <footer className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-relaxed text-white/60">
          <h2 className="mb-2 text-sm font-semibold text-white/80">
            Why the 2s looping .wav fights the seek bar
          </h2>
          <p className="mb-3">
            iOS draws the lock-screen seek bar from the <em>currently playing</em>{" "}
            element&apos;s real duration and currentTime.{" "}
            <code className="text-emerald-300">setPositionState()</code> is only a
            hint and gets overwritten whenever a second element is also playing.
            A 2-second looping silent file therefore makes the bar snap between
            &quot;2s / looping&quot; and the real track length.
          </p>
          <h2 className="mb-2 text-sm font-semibold text-white/80">The handoff</h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white/80">Playing</strong> — only the real
              track plays. The placeholder is paused, so iOS sees one duration.
            </li>
            <li>
              <strong className="text-white/80">Pause</strong> — the track pauses.
              A silent WAV generated to the <em>same length</em> as the track is
              seeked to the same currentTime and starts playing. Every ~1 second
              it rewinds 1 second, so the playhead (and the lock-screen bar)
              stays frozen at the paused position while iOS still has a live
              audio session.
            </li>
            <li>
              <strong className="text-white/80">Resume</strong> — placeholder
              pauses first, then the track plays from the frozen time. They are
              never both playing.
            </li>
          </ul>
          <p className="mt-3 text-xs text-white/40">
            Use the amber buttons to A/B this against &quot;always-on&quot; (the
            snapping bug) and &quot;no placeholder&quot; (session dies on pause).
            The live status chip shows which element currently owns the session.
          </p>
        </footer>
      </div>
    </div>
  );
}
