/**
 * Builds a silent PCM WAV of an exact duration.
 *
 * iOS lock-screen duration/position come from the *currently playing* element,
 * not from setPositionState (that's why a 2s looping anchor fights the real
 * track's seek bar). For the pause-hold handoff, the placeholder therefore
 * has to be as long as the track and start at the same currentTime.
 *
 * Memory: 16-bit 8 kHz mono ≈ 16 KB/s → a 5 min track is ~4.7 MB. We drop the
 * sample rate for very long files and cap at 60 minutes.
 */
export function createSilentWavUrl(durationSeconds = 2): string {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, 60 * 60));
  const sampleRate = seconds > 15 * 60 ? 4000 : 8000;
  const numSamples = Math.ceil(seconds * sampleRate);
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // samples are already 0 = 16-bit silence

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

export function describeSilentWav(durationSeconds: number): string {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, 60 * 60));
  const sampleRate = seconds > 15 * 60 ? 4000 : 8000;
  const kb = Math.round((seconds * sampleRate * 2) / 1024);
  return `${seconds.toFixed(1)}s @ ${sampleRate} Hz (~${kb} KB)`;
}
