// Generates a tiny, truly-silent looping WAV file at runtime (no network asset needed).
// This is used as a "silent audio anchor" - a trick some iOS media apps use so the
// browser/OS registers the page as an active *audio* session. iOS is far more willing
// to keep an audio session alive in the background/lock screen than a video-only session,
// so keeping a silent <audio> element looping alongside a <video> element can help the
// video keep playing after the screen locks or the app is backgrounded.
export function createSilentAudioUrl(durationSeconds = 2, sampleRate = 8000): string {
  const numSamples = durationSeconds * sampleRate;
  const blockAlign = 2; // 16-bit mono
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // samples are already zeroed (silence) by default ArrayBuffer initialization

  const blob = new Blob([buffer], { type: "audio/wav" });
  return URL.createObjectURL(blob);
}
