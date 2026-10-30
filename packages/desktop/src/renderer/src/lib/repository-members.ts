import type { BackendState, ProjectIcon } from "@omp-ui/core/types";

/**
 * The `data:` URL a project's monogram paints (#1000), or null for
 * initials. `?.` because a joined remote instance on an older omp-ui sends
 * records without the field.
 */
export function projectIconUrl(icon: ProjectIcon | null | undefined): string | null {
  return icon?.source === "detected" || icon?.source === "custom" ? icon.dataUrl : null;
}

/**
 * The identity seed a project's monogram hue derives from (ADR-0004): the
 * repository key when it has one, so every checkout of one repository shares
 * a colour, else the owning instance plus path. It doubles as the quick-open
 * row id.
 */
export function projectIdentitySeed(entry: { repositoryKey: string | null; instanceId: string | null; projectCwd: string }): string {
  return entry.repositoryKey !== null ? `repo:${entry.repositoryKey}` : `${entry.instanceId ?? "local"}\u0000${entry.projectCwd}`;
}

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
  /** The checkout's project icon as a `data:` URL (#1000); null = initials. */
  icon: string | null;
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
      icon: projectIconUrl(group.project.icon),
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
        icon: projectIconUrl(group.project.icon),
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
