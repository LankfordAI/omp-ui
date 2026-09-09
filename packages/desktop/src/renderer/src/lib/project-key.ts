/**
 * The renderer's key for a project registered on one instance (issue #416).
 * The same absolute path may be registered locally and on any number of
 * joined remote instances, so project-keyed maps (focused tab, branch lists,
 * branch activity) key on instance + path. Local projects keep the bare path:
 * persisted desktop view state predates this key and must stay valid.
 */
const SEPARATOR = "::";

export function projectKey(instanceId: string | null, path: string): string {
  return instanceId === null ? path : `${instanceId}${SEPARATOR}${path}`;
}

/**
 * Inverse of projectKey. Instance ids are UUIDs — never a path separator — so
 * a `::` inside a local path (which always carries one) is not a split point.
 */
export function splitProjectKey(key: string): { instanceId: string | null; path: string } {
  const at = key.indexOf(SEPARATOR);
  if (at === -1 || /[\\/]/.test(key.slice(0, at))) return { instanceId: null, path: key };
  return { instanceId: key.slice(0, at), path: key.slice(at + SEPARATOR.length) };
}
