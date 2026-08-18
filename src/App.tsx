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
            see what the real iOS lock screen draws. Toggle the settings below to switch
            between the two behaviors you screenshotted, and watch the event log to see
            exactly which Media Session actions iOS is calling.
          </p>
        </header>

        <MediaTestPlayer />

        <footer className="mt-10 rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-relaxed text-white/60">
          <h2 className="mb-2 text-sm font-semibold text-white/80">
            Why you're seeing two different lock screen layouts
          </h2>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong className="text-white/80">Round "±10s" arrows vs. plain chevrons</strong> —
              this is controlled entirely by which handlers you register with{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 text-emerald-300">
                navigator.mediaSession.setActionHandler
              </code>
              . Registering <code className="text-emerald-300">seekbackward</code>/
              <code className="text-emerald-300">seekforward</code> gives you the round
              arrows. Registering <code className="text-emerald-300">previoustrack</code>/
              <code className="text-emerald-300">nexttrack</code> instead gives you the
              chevrons. Registering both at the same time (which your repo currently does)
              produces inconsistent results across iOS versions/PWA vs. Safari.
            </li>
            <li>
              <strong className="text-white/80">Non-functional seek bar</strong> — the seek
              bar only becomes draggable if you (1) implement the{" "}
              <code className="text-emerald-300">seekto</code> handler and (2) call{" "}
              <code className="text-emerald-300">navigator.mediaSession.setPositionState()</code>{" "}
              early and often (on load, on play, on every seek, and throttled during
              playback). It also tends to work far more reliably when the session is driven
              by a <code className="text-emerald-300">&lt;video&gt;</code> element rather
              than an <code className="text-emerald-300">&lt;audio&gt;</code> element.
            </li>
            <li>
              <strong className="text-white/80">Works on web but not as an installed app</strong>{" "}
              — this matches known WebKit bugs: standalone home-screen PWAs on iOS can lose
              a responsive audio/lock-screen session after ~30s of pausing (WebKit bug
              261858), and Picture-in-Picture is unavailable in standalone PWA mode (WebKit
              bug 303885). Testing in a normal Safari tab sidesteps both, which is why it
              "only works in the web version."
            </li>
            <li>
              <strong className="text-white/80">Keeping video alive in the background</strong>{" "}
              — iOS is much more willing to keep an <em>audio</em> session running after you
              lock the screen than a video-only session. A common trick (toggle it above) is
              to loop a silent, near-zero-volume <code className="text-emerald-300">&lt;audio&gt;</code>{" "}
              element alongside your video so the OS treats the page as an active audio
              session and doesn't suspend playback when you leave the app.
            </li>
          </ul>
          <p className="mt-3 text-xs text-white/40">
            Tip: for the most accurate test, add this page to your Home Screen (Safari
            Share → Add to Home Screen) to test standalone-PWA behavior, and also test it as
            a normal Safari tab — then compare the event log and real lock screen for each.
          </p>
        </footer>
      </div>
    </div>
  );
}
