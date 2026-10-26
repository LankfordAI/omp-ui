import type { BackendState } from "@omp-ui/core/types";

/**
 * The repository merge shared by the Project quick-open and the composer's
 * machine chip (issues #903, #936): both derive a repository's checkouts —
 * its members — from the same registry walk and grouping.
 */

/** One registered project on one host, before the repository merge. */
export interface CheckoutEntry {
  /** null = this app. */
  instanceId: string | null;
  projectCwd: string;
  name: string;
  /** Full path tooltip; set for remote entries only. */
  title?: string;
  repositoryKey: string | null;
}

/** Local registry first, then each joined instance (status !== "self"), registry order. */
export function checkoutEntries(state: BackendState | null): CheckoutEntry[] {
  const out: CheckoutEntry[] = [];
  for (const group of state?.projects ?? []) {
    out.push({
      instanceId: null,
      projectCwd: group.project.path,
      name: group.project.name,
      repositoryKey: group.project.repositoryKey,
    });
  }
  const joined = (state?.remoteInstances ?? []).filter((instance) => instance.status !== "self");
  for (const instance of joined) {
    for (const group of instance.projects) {
      out.push({
        instanceId: instance.id,
        projectCwd: group.project.path,
        name: group.project.name,
        title: group.project.path,
        repositoryKey: group.project.repositoryKey,
      });
    }
  }
  return out;
}

/**
 * One group per non-null repositoryKey; null keys group by identical
 * projectCwd only — a keyless checkout NEVER merges across machines except by
 * identical path. First-seen order.
 */
export function groupByRepository(
  entries: readonly CheckoutEntry[],
): { key: string | null; members: CheckoutEntry[] }[] {
  const byKey = new Map<string | null, CheckoutEntry[]>();
  for (const entry of entries) {
    const list = byKey.get(entry.repositoryKey);
    if (list === undefined) byKey.set(entry.repositoryKey, [entry]);
    else list.push(entry);
  }
  const groups: { key: string | null; members: CheckoutEntry[] }[] = [];
  for (const [key, members] of byKey) {
    if (key !== null) {
      groups.push({ key, members });
      continue;
    }
    const byPath = new Map<string, CheckoutEntry[]>();
    for (const entry of members) {
      const list = byPath.get(entry.projectCwd);
      if (list === undefined) byPath.set(entry.projectCwd, [entry]);
      else list.push(entry);
    }
    for (const list of byPath.values()) groups.push({ key: null, members: list });
  }
  return groups;
}

/** Members of the group containing (instanceId, projectCwd); [] when that pair is not registered. */
export function repositoryMembers(
  state: BackendState | null,
  instanceId: string | null,
  projectCwd: string,
): CheckoutEntry[] {
  return (
    groupByRepository(checkoutEntries(state)).find((g) =>
      g.members.some((m) => m.instanceId === instanceId && m.projectCwd === projectCwd),
    )?.members ?? []
  );
}
