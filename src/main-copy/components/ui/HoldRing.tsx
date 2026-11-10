import { HOLD_RING_VISIBLE_MS } from "./useHoldToDrag";

const SIZE = 32;          // column width in px
const STROKE_WIDTH = 3;   // thickness of the ring
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function HoldRing({ durationMs = HOLD_RING_VISIBLE_MS }: { durationMs?: number }) {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      className="pointer-events-none"
    >
      {/* Background track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="rgba(255,255,255,0.15)"
        strokeWidth={STROKE_WIDTH}
      />

      {/* Progress ring via SMIL: neither framer nor CSS animations drive SVG
          geometry reliably here, but declarative <animate> always runs while
          mounted (mount = finger down, unmount = release = free reset). */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="white"
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      >
        <animate
          attributeName="stroke-dashoffset"
          from={CIRCUMFERENCE.toString()}
          to="0"
          dur={`${durationMs / 1000}s`}
          fill="freeze"
        />
      </circle>
    </svg>
  );
}
