import { addLog } from './logger'

const lastByKey = new Map<string, number>()

/**
 * Temporary drag telemetry (remove once the scroll-drift is diagnosed).
 * Samples pointer Y vs the dragged row's actual top vs container scroll —
 * the three numbers discriminate gesture-level drift (transform diverges
 * from pointer) from order-computation errors (transform tracks, slot wrong).
 */
export function telemetryDragSample(key: string, el: HTMLElement | null, pointY: number) {
  const now = Date.now()
  if (now - (lastByKey.get(key) ?? 0) < 500) return
  lastByKey.set(key, now)
  try {
    if (!el) {
      addLog(`dragtele ${key}: no element`)
      return
    }
    const sc = el.closest('[data-dragscroll]') as HTMLElement | null
    const stop = sc ? Math.round(sc.scrollTop) : -1
    const top = Math.round(el.getBoundingClientRect().top)
    addLog(`dragtele ${key}: pointerY=${Math.round(pointY)} rowTop=${top} scrollTop=${stop}`)
  } catch {
    /* never break gestures for telemetry */
  }
}
