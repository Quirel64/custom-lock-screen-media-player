// Generates SVG artwork data URLs for MediaSession lock screen display.
// Playing state: music note icon on indigo gradient
// Paused state: pause icon on dark slate background

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

let playingArtwork: string | null = null
let pausedArtwork: string | null = null

export function getPlayingArtwork(): string {
  if (playingArtwork) return playingArtwork
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6366f1"/>
        <stop offset="100%" style="stop-color:#8b5cf6"/>
      </linearGradient>
    </defs>
    <rect width="300" height="300" rx="40" fill="url(#bg)"/>
    <g transform="translate(150,145)" fill="white">
      <circle cx="0" cy="52" r="22" fill="white"/>
      <rect x="-3" y="-60" width="6" height="112" rx="3" fill="white"/>
      <path d="M 3 -60 L 3 -45 Q 40 -40 35 -15 L 3 -20" fill="white"/>
    </g>
  </svg>`
  playingArtwork = svgToDataUrl(svg)
  return playingArtwork
}

export function getPausedArtwork(): string {
  if (pausedArtwork) return pausedArtwork
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
    <rect width="300" height="300" rx="40" fill="#1e293b"/>
    <g transform="translate(150,150)" fill="white">
      <rect x="-25" y="-40" width="16" height="80" rx="4" fill="white"/>
      <rect x="9" y="-40" width="16" height="80" rx="4" fill="white"/>
    </g>
  </svg>`
  pausedArtwork = svgToDataUrl(svg)
  return pausedArtwork
}
