/** Periodic work that must not run while the window is hidden (#858): the
 * callback is skipped for the whole hidden stretch and fires once the moment
 * the window is revealed, so whatever the tick shows is current on return.
 * Chromium already freezes rAF loops and throttles timers to ~1/min when a
 * window is occluded; this makes the pause total and the reveal refresh
 * deterministic instead of "within a minute". Returns a stop function. */
export function startVisibleInterval(callback: () => void, ms: number): () => void {
  let timer: number | undefined;
  const arm = (): void => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    if (!document.hidden) timer = window.setInterval(callback, ms);
  };
  const onVisibility = (): void => {
    if (document.hidden) return arm();
    callback();
    arm();
  };
  arm();
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    if (timer !== undefined) window.clearInterval(timer);
  };
}
