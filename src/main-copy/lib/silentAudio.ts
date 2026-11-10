/**
 * Silent WAV for same-element handoff — duration-matched so lock-screen bar doesn't snap.
 * One permanent <audio> swaps src track <-> silent placeholder. PWA iOS needs same-element, not cross-element.
 * 8kHz mono ~16KB/s, 5min ~4.7MB; cap 60min, 4kHz for very long.
 */
export function createSilentWavBlob(durationSeconds: number): Blob {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, 60 * 60))
  const sampleRate = seconds > 15 * 60 ? 4000 : 8000
  const numSamples = Math.ceil(seconds * sampleRate)
  const blockAlign = 2
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE")
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true)
  writeStr(36, "data"); view.setUint32(40, dataSize, true)
  return new Blob([buffer], { type: "audio/wav" })
}

export function createSilentWavUrl(durationSeconds: number): string {
  return URL.createObjectURL(createSilentWavBlob(durationSeconds))
}

export function describeSilentWav(durationSeconds: number): string {
  const seconds = Math.max(1, Math.min(Number(durationSeconds) || 2, 60 * 60))
  const sr = seconds > 15 * 60 ? 4000 : 8000
  const kb = Math.round((seconds * sr * 2) / 1024)
  return `${seconds.toFixed(1)}s @ ${sr} Hz (~${kb} KB)`
}
