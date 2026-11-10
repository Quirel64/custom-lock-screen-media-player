import { useEffect, useRef, useCallback } from 'react'
import { addLog } from '../../lib/logger'

interface ScrollSlotSyncOptions {
  containerRef: React.RefObject<HTMLElement | null>
  active: boolean
  draggedIdRef: React.RefObject<string | null>
  getIds: () => string[]
  setIds: (ids: string[]) => void
  label: string
}

/**
 * Scroll-driven slot sync for Reorder drags.
 *
 * framer only re-evaluates slots inside pointer events AND only when pointer
 * velocity on the drag axis is non-zero (check-reorder.mjs:38). A finger
 * parked in the autoscroll edge zone keeps the list scrolling (scroll events
 * fire on every programmatic step) but freezes slot updates: rows flow under
 * the finger while order/numbers lag, and the drop lands "earlier than it
 * looked". The wiggle re-opens the velocity gate — the exact workaround the
 * user reported.
 *
 * This closes the gap with pure geometry: whenever the container scrolls
 * during a drag, the dragged id moves to the slot under the FINGER (last
 * pointer clientY — viewport-fixed, so it survives content flowing past a
 * parked finger; falls back to the row center before the first pointermove).
 * It applies through the same setIds/onReorder path framer uses, so the
 * engine and commit logic see a normal reorder.
 *
 * Scope: fires ONLY on scroll — framer owns the pointer-move path (its
 * velocity logic works there). The same-frame guard (DOM order must equal
 * the mirror) skips frames where framer's own reorder hasn't rendered yet,
 * so the two never fight over one event.
 */
export function useScrollSlotSync({ containerRef, active, draggedIdRef, getIds, setIds, label }: ScrollSlotSyncOptions) {
  const fns = useRef({ getIds, setIds })
  fns.current = { getIds, setIds }
  const pointerYRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastScrollTop = useRef(0)

  const syncNow = useCallback(() => {
    const draggedId = draggedIdRef.current
    const container = containerRef.current
    if (!draggedId || !container) return
    const group = container.firstElementChild
    if (!group) return
    const rows = Array.from(group.children) as HTMLElement[]
    const domIds = rows.map((r) => r.dataset.dragId ?? '')
    const ids = fns.current.getIds()
    // Same-set sanity: playlist rows can skip missing tracks (null render);
    // a pending render means framer's own move owns this frame anyway.
    if (domIds.length === 0 || domIds.length !== ids.length) return
    for (let i = 0; i < domIds.length; i++) if (domIds[i] !== ids[i]) return
    const dragIndex = ids.indexOf(draggedId)
    if (dragIndex === -1) return
    const centers = rows.map((r) => {
      const b = r.getBoundingClientRect()
      return b.top + b.height / 2
    })
    const anchor = pointerYRef.current ?? centers[dragIndex]
    let target = 0
    for (let i = 0; i < centers.length; i++) {
      if (i !== dragIndex && centers[i] < anchor) target++
    }
    if (target === dragIndex) return
    const next = ids.slice()
    next.splice(dragIndex, 1)
    next.splice(target, 0, draggedId)
    fns.current.setIds(next)
    addLog(`scrollslot ${label}: ${dragIndex}→${target}`)
  }, [containerRef, draggedIdRef, label])

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    // Fresh drag: no stale anchor from a previous gesture.
    pointerYRef.current = null
    lastScrollTop.current = container.scrollTop
    const onPointer = (e: PointerEvent) => {
      pointerYRef.current = e.clientY
    }
    const onScroll = () => {
      // rAF-coalesce: scroll fires per programmatic step; one check per frame.
      if (rafRef.current != null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        if (container.scrollTop === lastScrollTop.current) return
        lastScrollTop.current = container.scrollTop
        syncNow()
      })
    }
    window.addEventListener('pointermove', onPointer, { passive: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onPointer)
      container.removeEventListener('scroll', onScroll)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, containerRef, syncNow])

  return syncNow
}
