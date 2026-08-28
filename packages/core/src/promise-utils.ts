/**
 * True when `p` settles inside `ms`. Bounded wait, no dangling timer: the
 * race's own timeout is cleared whichever side wins, so a fast settle leaves
 * zero pending handles.
 */
export function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
