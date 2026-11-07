// Keep DOM-dependent book work in small slices, giving input and painting priority.
export function readingSlice(signal: AbortSignal, background = true): Promise<number> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    let idle: number | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { signal.removeEventListener('abort', cancel); if (idle !== undefined) cancelIdleCallback(idle); if (timer !== undefined) clearTimeout(timer) }
    const cancel = () => { cleanup(); reject(signal.reason) }
    const ready = (budget: number) => { cleanup(); resolve(performance.now() + Math.max(1, Math.min(6, budget))) }
    signal.addEventListener('abort', cancel, { once: true })
    if (background && typeof requestIdleCallback === 'function') idle = requestIdleCallback(deadline => ready(deadline.timeRemaining()), { timeout: 200 })
    else timer = setTimeout(() => ready(6), 0)
  })
}
