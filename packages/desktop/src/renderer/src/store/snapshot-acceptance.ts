export interface RevisionedProcessSnapshot {
  processKey: string;
  revision: number;
}

/** New processes always replace; one process accepts strictly increasing revisions. */
export function isNewerSnapshot(
  retained: RevisionedProcessSnapshot | null,
  incoming: RevisionedProcessSnapshot,
): boolean {
  return (
    retained === null ||
    retained.processKey !== incoming.processKey ||
    incoming.revision > retained.revision
  );
}
