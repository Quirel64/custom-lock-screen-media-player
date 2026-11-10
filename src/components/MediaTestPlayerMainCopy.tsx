/**
 * CARBON COPY TAB — the main media player, verbatim.
 *
 * Source: `media player backup` (the main player's repo, latest commit at copy
 * time b5e2c76), whole-tree copied to src/main-copy/ unmodified.
 *
 * Why this exists: round-3 testing proved the Arena tab cannot reproduce the
 * 27.2 wedge even in main-player shape (dual-play = genuinely playing muted
 * video alongside) under the full flag matrix — while the main player wedges.
 * Mounting the real app lets us bisect the remaining environment differences:
 * OPFS/IndexedDB-sourced media, the zustand store, library thumbnail probes,
 * the VideoSyncController seek pattern while hidden, long-lived sessions.
 *
 * Isolation notes: the copy carries its OWN zustand store, its own IndexedDB
 * (no name collisions with this test env), and registers its own MediaSession
 * handlers — only one tab is mounted at a time, so handler registration never
 * overlaps with the Arena/Freeze tabs. Its quirks are therefore REAL main-app
 * quirks, not contamination.
 */
import MainApp from "../main-copy/App";
import "../main-copy/index.css";

export default function MediaTestPlayerMainCopy() {
  return (
    <div id="main-copy-root" className="relative">
      <MainApp />
    </div>
  );
}
