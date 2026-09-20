import { REMOTE_CLOSE_REVOKED } from "./protocol";

export const REMOTE_CONNECT_TIMEOUT_MS = 10_000;
export const REMOTE_FRAME_RETRY_INITIAL_MS = 500;
export const REMOTE_FRAME_RETRY_MAX_MS = 5_000;

export function nextFrameRetryDelay(current: number): number {
  return Math.min(current * 2, REMOTE_FRAME_RETRY_MAX_MS);
}

export function isCredentialClose(code: number): boolean {
  return code === REMOTE_CLOSE_REVOKED || code === 1008;
}

/** Dispatches one delivery to every sink and settles after asynchronous sinks. */
export function dispatchRemoteListeners<T>(
  listeners: Iterable<T>,
  invoke: (listener: T) => void | Promise<void>,
): void | Promise<void> {
  let waits: Promise<void>[] | undefined;
  for (const listener of listeners) {
    try {
      const result = invoke(listener);
      if (result !== undefined) (waits ??= []).push(result);
    } catch {
      // A failed receiver drops this delivery instead of holding frame credit.
    }
  }
  if (waits !== undefined) return Promise.allSettled(waits).then(() => undefined);
}
