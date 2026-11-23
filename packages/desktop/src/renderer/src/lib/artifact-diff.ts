import { artifactCanonicalJson, type ArtifactJson } from "@omp-ui/core/artifacts";

export type ArtifactValueDiff =
  | {
      kind: "keyed-array";
      added: Array<{ key: string; value: ArtifactJson }>;
      removed: Array<{ key: string; value: ArtifactJson }>;
      changed: Array<{ key: string; before: ArtifactJson; after: ArtifactJson }>;
      unchangedCount: number;
    }
  | {
      kind: "object-keys";
      added: Array<{ key: string; value: ArtifactJson }>;
      removed: Array<{ key: string; value: ArtifactJson }>;
      changed: Array<{ key: string; before: ArtifactJson; after: ArtifactJson }>;
      unchangedCount: number;
    }
  | {
      kind: "summary";
      beforeType: string;
      afterType: string;
      beforeCount: number | null;
      afterCount: number | null;
      identical: boolean;
    };

function isPlainObject(value: ArtifactJson): value is { [key: string]: ArtifactJson } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describeType(value: ArtifactJson): { label: string; count: number | null } {
  if (value === null) return { label: "null", count: null };
  if (Array.isArray(value)) return { label: "array", count: value.length };
  if (typeof value === "object") return { label: "object", count: Object.keys(value).length };
  return { label: typeof value, count: null };
}

function indexByUniqueId(items: ArtifactJson[]): Map<string, ArtifactJson> | null {
  const map = new Map<string, ArtifactJson>();
  for (const item of items) {
    if (!isPlainObject(item)) return null;
    if (!Object.hasOwn(item, "id")) return null;
    const rawId = item.id;
    let key: string;
    if (typeof rawId === "string") key = `s:${rawId}`;
    else if (typeof rawId === "number" && Number.isFinite(rawId)) key = `n:${rawId}`;
    else return null;
    if (map.has(key)) return null;
    map.set(key, item);
  }
  return map;
}

function displayKey(internalKey: string): string {
  return internalKey.slice(2);
}

/**
 * Deterministic structured diff for capture review (#1307):
 * 1. Keyed array diff iff both sides are arrays of plain objects with unique scalar string/finite-number `id`.
 * 2. Top-level object key diff iff both sides are plain objects.
 * 3. Summary fallback otherwise.
 */
export function diffArtifactValues(before: ArtifactJson, after: ArtifactJson): ArtifactValueDiff {
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeMap = indexByUniqueId(before);
    const afterMap = indexByUniqueId(after);
    if (beforeMap !== null && afterMap !== null) {
      const added: Array<{ key: string; value: ArtifactJson }> = [];
      const removed: Array<{ key: string; value: ArtifactJson }> = [];
      const changed: Array<{ key: string; before: ArtifactJson; after: ArtifactJson }> = [];
      let unchangedCount = 0;

      for (const [k, afterVal] of afterMap) {
        if (!beforeMap.has(k)) {
          added.push({ key: displayKey(k), value: afterVal });
        } else {
          const beforeVal = beforeMap.get(k)!;
          if (artifactCanonicalJson(beforeVal) !== artifactCanonicalJson(afterVal)) {
            changed.push({ key: displayKey(k), before: beforeVal, after: afterVal });
          } else {
            unchangedCount++;
          }
        }
      }
      for (const [k, beforeVal] of beforeMap) {
        if (!afterMap.has(k)) {
          removed.push({ key: displayKey(k), value: beforeVal });
        }
      }
      return { kind: "keyed-array", added, removed, changed, unchangedCount };
    }
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const added: Array<{ key: string; value: ArtifactJson }> = [];
    const removed: Array<{ key: string; value: ArtifactJson }> = [];
    const changed: Array<{ key: string; before: ArtifactJson; after: ArtifactJson }> = [];
    let unchangedCount = 0;

    const beforeKeys = new Set(Object.keys(before));
    for (const key of Object.keys(after)) {
      if (!beforeKeys.has(key)) {
        added.push({ key, value: after[key]! });
      } else if (artifactCanonicalJson(before[key]!) !== artifactCanonicalJson(after[key]!)) {
        changed.push({ key, before: before[key]!, after: after[key]! });
      } else {
        unchangedCount++;
      }
    }
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) {
        removed.push({ key, value: before[key]! });
      }
    }
    return { kind: "object-keys", added, removed, changed, unchangedCount };
  }

  const left = describeType(before);
  const right = describeType(after);
  return {
    kind: "summary",
    beforeType: left.label,
    afterType: right.label,
    beforeCount: left.count,
    afterCount: right.count,
    identical: artifactCanonicalJson(before) === artifactCanonicalJson(after),
  };
}
