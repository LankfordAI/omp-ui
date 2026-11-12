import type { BackendState, ProjectIcon, ProjectRecord } from "@omp-ui/core/types";
import { projectKey } from "./project-key";

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

/** A project's monogram identity, as every session surface paints it. */
export interface ProjectFace {
  name: string;
  /** projectIdentitySeed: the hue source shared with the quick-open row. */
  seed: string;
  /** data: URL, or null for initials. */
  icon: string | null;
}

const facesByState = new WeakMap<BackendState, ReadonlyMap<string, ProjectFace>>();

/**
 * Every registered project's face on this app and every non-self instance,
 * keyed by projectKey(instanceId, path). Cached per BackendState, so a store
 * selector returns the same object until state changes. Seed rule matches the
 * quick-open: a repository key shares one hue across machines. Icon rule: the
 * checkout's own icon, else the first icon among its repository members in
 * registry order (the quick-open's merged-row fallback).
 */
export function projectFaces(state: BackendState): ReadonlyMap<string, ProjectFace> {
  const cached = facesByState.get(state);
  if (cached !== undefined) return cached;
  const faces = new Map<string, ProjectFace>();
  for (const group of groupByRepository(checkoutEntries(state))) {
    const fallback = group.members.find((m) => m.icon !== null)?.icon ?? null;
    for (const m of group.members) {
      faces.set(projectKey(m.instanceId, m.projectCwd), {
        name: m.name,
        seed: projectIdentitySeed({ repositoryKey: group.key, instanceId: m.instanceId, projectCwd: m.projectCwd }),
        icon: m.icon ?? fallback,
      });
    }
  }
  facesByState.set(state, faces);
  return faces;
}

/** The face for one registered project; falls back to its own record if the map lacks it. */
export function projectFaceFor(state: BackendState, instanceId: string | null, project: ProjectRecord): ProjectFace {
  return (
    projectFaces(state).get(projectKey(instanceId, project.path)) ?? {
      name: project.name,
      seed: projectIdentitySeed({ repositoryKey: project.repositoryKey, instanceId, projectCwd: project.path }),
      icon: projectIconUrl(project.icon),
    }
  );
}
