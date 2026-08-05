import type { PtyHandle } from "./pty";

/**
 * Coalesces bursts of small PTY chunks into single callbacks (5 ms window —
 * far below frame latency; xterm.js queues writes internally anyway). Lives
 * in core so the future WebSocket transport inherits the same batching.
 *
 * `kill` clears every pending flush: a coalescing timer must never outlive
 * the handle it feeds, and chunks arriving after kill are dropped — whoever
 * killed the handle has already torn down the consumer.
 */
export function batched(handle: PtyHandle, windowMs = 5): PtyHandle {
  const timers = new Set<NodeJS.Timeout>();
  let killed = false;
  return {
    ...handle,
    onData: (cb) => {
      let pending: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      return handle.onData((chunk) => {
        if (killed) return;
        pending.push(chunk);
        if (timer === undefined) {
          timer = setTimeout(() => {
            timers.delete(timer!);
            timer = undefined;
            cb(pending.length === 1 ? pending[0]! : Buffer.concat(pending));
            pending = [];
          }, windowMs);
          timers.add(timer);
        }
      });
    },
    kill: (signal) => {
      killed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      handle.kill(signal);
    },
  };
}
