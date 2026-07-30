import type { PtyHandle } from "./pty";

/**
 * Coalesces bursts of small PTY chunks into single callbacks (5 ms window —
 * far below frame latency; xterm.js queues writes internally anyway). Lives
 * in core so the future WebSocket transport inherits the same batching.
 */
export function batched(handle: PtyHandle, windowMs = 5): PtyHandle {
  return {
    ...handle,
    onData: (cb) => {
      let pending: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      handle.onData((chunk) => {
        pending.push(chunk);
        timer ??= setTimeout(() => {
          timer = undefined;
          cb(pending.length === 1 ? pending[0]! : Buffer.concat(pending));
          pending = [];
        }, windowMs);
      });
    },
  };
}
