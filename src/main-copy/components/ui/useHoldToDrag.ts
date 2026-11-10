import { useRef, useEffect, useState, useCallback } from 'react'

// Hold ~600ms (modern long-press timing — 1.5s feels broken) to start a drag
// on already-live controls. Any pointer movement first means "scroll", so the
// timer dies and scrolling stays intact. Exported so hold-progress UI (ring)
// can share the exact timing — no magic numbers in two places.
export const HOLD_MS = 600
// Ring grace: plain taps (<100ms) never flash UI; the ring then fills in the
// remaining time so lift still lands exactly at HOLD_MS.
export const HOLD_RING_DELAY_MS = 100
export const HOLD_RING_VISIBLE_MS = HOLD_MS - HOLD_RING_DELAY_MS

function buzz() {
  try {
    ;(navigator as Navigator & { vibrate?: (p: number) => boolean }).vibrate?.(15)
  } catch {
    /* iOS ignores it — no-op */
  }
}

// touch-action is decided when the gesture STARTS, so flipping classes at
// hold-fire arrives too late on iOS: the browser already claimed scrolling and
// the first move pointercancels the drag. The working fix is a non-passive
// touchmove preventer installed at fire time (finger still stationary, events
// still cancelable) for the rest of that one gesture only.
export function blockTouchScroll() {
  document.addEventListener('touchmove', preventTouchMove, { passive: false })
}

export function unblockTouchScroll() {
  document.removeEventListener('touchmove', preventTouchMove)
}

function preventTouchMove(e: TouchEvent) {
  if (e.cancelable) e.preventDefault()
}

export function useHoldToDrag(
  opts?: {
    /** Gate evaluated at fire time (e.g. not in select mode). */
    shouldStart?: () => boolean
    /** Runs just before start (e.g. flip visual Order mode). */
    onStarting?: () => void
    /** Starts the drag on the custom row-drag engine. */
    onFire?: (e: PointerEvent) => void
  },
) {
  const [dragging, setDragging] = useState(false)
  // True while the hold timer runs (finger down, not yet moved/released).
  // Row UI reads this to render hold-progress (e.g. a filling ring); it flips
  // false the moment the drag starts, is cancelled, or the finger lifts.
  const [holding, setHolding] = useState(false)
  // Armed a beat after holding starts so plain taps never flash the ring.
  const [holdArmed, setHoldArmed] = useState(false)
  const armTimer = useRef<number | null>(null)
  const timer = useRef<number | null>(null)
  const eventRef = useRef<PointerEvent | null>(null)
  // Latest opts without re-creating the timer callback every render.
  const fireOpts = useRef(opts)
  useEffect(() => {
    fireOpts.current = opts
  })

  const clear = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (armTimer.current != null) {
      clearTimeout(armTimer.current)
      armTimer.current = null
    }
    setHolding(false)
    setHoldArmed(false)
  }, [])

  useEffect(() => clear, [clear])
  useEffect(() => unblockTouchScroll, [])

  const end = useCallback(() => {
    clear()
    unblockTouchScroll()
    setDragging(false)
  }, [clear])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      eventRef.current = e.nativeEvent
      clear()
      setHolding(true)
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null
        setHoldArmed(true)
      }, HOLD_RING_DELAY_MS)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setHolding(false)
        setHoldArmed(false)
        const evt = eventRef.current
        if (!evt) return
        if (fireOpts.current?.shouldStart && !fireOpts.current.shouldStart()) return
        // Finger is still stationary: flip touch-action BEFORE the first move
        // so the browser hands the gesture to the drag, not the scroller.
        setDragging(true)
        buzz()
        try {
          fireOpts.current?.onStarting?.()
        } catch {
          /* visual flip is best-effort */
        }
        if (evt.pointerType === 'touch' || evt.pointerType === 'pen') blockTouchScroll()
        if (fireOpts.current?.onFire) {
          try {
            fireOpts.current.onFire(evt)
          } catch {
            unblockTouchScroll()
            setDragging(false)
          }
        } else {
          unblockTouchScroll()
          setDragging(false)
        }
      }, HOLD_MS)
    },
    [clear],
  )

  return {
    onPointerDown,
    onPointerMove: clear,
    onPointerUp: end,
    onPointerCancel: end,
    dragging,
    holding,
    holdArmed,
  }
}
