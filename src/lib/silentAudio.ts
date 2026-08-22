/**
 * Generate a silent PCM WAV as a Blob/ObjectURL.
 *
 * For the lock-screen handoff trick we want the anchor's *reported duration*
 * to match the real track, so iOS never briefly flashes a 2s seek bar.
 * We cap the generated buffer length to keep memory reasonable; for longer
 * tracks the anchor simply loops and we pin its currentTime every tick.
 */
const MAX_GENERATED_SECONDS = 15 * 60; // 15 minutes of silence max
const SAMPLE_RATE = 8000; // low rate — silence, so quality is irrelevant

export function createSilentWavBlob(durationSeconds: number): Blob {
  const seconds = Math.max(1, Math.min(durationSeconds, MAX_GENERATED_SECONDS));
  const numSamples = Math.floor(seconds * SAMPLE_RATE);
  const blockAlign = 2; // 16-bit mono
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  // samples stay zeroed = silence

  return new Blob([buffer], { type: "audio/wav" });
}

export function createSilentAudioUrl(durationSeconds = 2): string {
  return URL.createObjectURL(createSilentWavBlob(durationSeconds));
}
