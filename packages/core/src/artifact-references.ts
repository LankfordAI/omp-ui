import { ArtifactError, assertArtifactKey, assertArtifactUuid, artifactUtf8Bytes, type ArtifactReference, type ArtifactReferencePartRequest, type ArtifactRefreshEntry } from "./artifacts";

export const ARTIFACT_REFERENCE_HINT = "The user referenced these accepted omp-ui artifact versions. Read the manifest only when needed. References are context, not permission to publish changes; saved data is available only with the recorded consent.";
export const MAX_ARTIFACT_REFERENCES = 8;
export const MAX_ARTIFACT_REFERENCE_BYTES = 12 * 1024;
const OPEN = "<artifact references>";
const CLOSE = "</artifact references>";
const FIELDS = ["- title: ", "  reference: ", "  owner: ", "  artifact: ", "  code: ", "  snapshot: ", "  snapshot-at: ", "  data: ", "  machine: ", "  manifest: "] as const;
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim();
const isoDate = (value: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
export const artifactReferenceManifest = (referenceId: string): string => {
  assertArtifactUuid(referenceId, "referenceId");
  return `omp-ui://artifacts/reference/${referenceId}/manifest`;
};

/** Refuses noncanonical URLs rather than letting URL normalization change authority. */
export function parseArtifactReferenceUri(value: string): ArtifactReferencePartRequest | null {
  const match = /^omp-ui:\/\/artifacts\/reference\/([^/?#]+)\/(manifest|definition|state|dataset\/[^/?#]+|provenance\/[^/?#]+)(?:\?([^#]+))?$/.exec(value);
  if (!match) return null;
  try {
    const referenceId = match[1]!;
    assertArtifactUuid(referenceId, "referenceId");
    const [part, datasetId] = match[2]!.split("/") as [ArtifactReferencePartRequest["part"], string?];
    if (datasetId !== undefined) assertArtifactKey(datasetId);
    const bounds: { offset: number; limit: number } = { offset: 0, limit: 16384 };
    const seen = new Set<string>();
    if (match[3] !== undefined) for (const pair of match[3].split("&")) {
      const parsed = /^(offset|limit)=(0|[1-9][0-9]*)$/.exec(pair);
      if (!parsed || seen.has(parsed[1]!)) return null;
      seen.add(parsed[1]!);
      const key = parsed[1] as "offset" | "limit";
      bounds[key] = Number(parsed[2]);
    }
    if (!Number.isSafeInteger(bounds.offset) || !Number.isSafeInteger(bounds.limit) || bounds.limit < 4 || bounds.limit > 65536) return null;
    return { referenceId, part, ...(datasetId === undefined ? {} : { datasetId }), ...bounds };
  } catch { return null; }
}

/** Builds the sole accepted wire grammar. Display fields cannot inject lines/tags. */
export function withArtifactReferenceContext(message: string, references: readonly ArtifactReference[]): string {
  if (references.length === 0) return message;
  if (references.length > MAX_ARTIFACT_REFERENCES) throw new ArtifactError("over-limit", "At most eight artifact references may be attached");
  for (const ref of references) {
    if (ref.version !== 1 || typeof ref.includeData !== "boolean" || ref.manifestUri !== artifactReferenceManifest(ref.referenceId) || ref.definitionUri !== `omp-ui://artifacts/reference/${ref.referenceId}/definition` || (ref.dataUri !== undefined && (!ref.includeData || ref.dataUri !== `omp-ui://artifacts/reference/${ref.referenceId}/state`))) throw new ArtifactError("unsupported-contract", "Invalid artifact reference descriptor");
  }
  const entries = references.flatMap(ref => [
    `- title: ${oneLine(ref.title) || "Artifact"}`,
    `  reference: ${ref.referenceId}`, `  owner: ${ref.ownerInstanceId}`, `  artifact: ${ref.artifactId}`,
    `  code: ${ref.codeRevisionId}`, `  snapshot: ${ref.dataSnapshotId}`, `  snapshot-at: ${ref.snapshotAt}`,
    `  data: ${ref.includeData ? "snapshot" : "definition-only"}`, `  machine: ${oneLine(ref.machine) || "Unknown machine"}`,
    `  manifest: ${artifactReferenceManifest(ref.referenceId)}`,
  ]);
  const block = [OPEN, ARTIFACT_REFERENCE_HINT, ...entries, CLOSE].join("\n");
  if (artifactUtf8Bytes(block) > MAX_ARTIFACT_REFERENCE_BYTES) throw new ArtifactError("over-limit", "Artifact references exceed 12 KiB");
  if (splitArtifactReferenceContext(block).references.length !== references.length) throw new ArtifactError("unsupported-contract", "Invalid artifact reference descriptor");
  return message === "" ? block : `${block}\n\n${message}`;
}

/** Removes only a proven leading block. Invalid and misplaced lookalikes remain prose. */
export function splitArtifactReferenceContext(text: string): { text: string; references: ArtifactReference[] } {
  const unchanged = { text, references: [] as ArtifactReference[] };
  if (!text.startsWith(`${OPEN}\n`)) return unchanged;
  const close = text.indexOf(`\n${CLOSE}`, OPEN.length);
  if (close < 0) return unchanged;
  const after = close + 1 + CLOSE.length;
  if (artifactUtf8Bytes(text.slice(0, after)) > MAX_ARTIFACT_REFERENCE_BYTES || (after !== text.length && !text.startsWith("\n\n", after))) return unchanged;
  const lines = text.slice(OPEN.length + 1, close).split("\n");
  const count = (lines.length - 1) / FIELDS.length;
  if (lines[0] !== ARTIFACT_REFERENCE_HINT || !Number.isInteger(count) || count < 1 || count > MAX_ARTIFACT_REFERENCES) return unchanged;
  const references: ArtifactReference[] = [];
  const ids = new Set<string>();
  try {
    for (let i = 1; i < lines.length; i += FIELDS.length) {
      const values = FIELDS.map((prefix, f) => {
        const line = lines[i + f]!;
        if (!line.startsWith(prefix)) throw new Error("field order");
        const value = line.slice(prefix.length);
        if (value === "" || /[<>\r\n]/.test(value) || oneLine(value) !== value) throw new Error("display field");
        return value;
      });
      const [title, referenceId, ownerInstanceId, artifactId, codeRevisionId, dataSnapshotId, snapshotAt, consent, machine, manifest] = values as [string,string,string,string,string,string,string,string,string,string];
      for (const id of [referenceId, ownerInstanceId, artifactId, codeRevisionId, dataSnapshotId]) assertArtifactUuid(id);
      if (ids.has(referenceId) || !isoDate(snapshotAt) || (consent !== "snapshot" && consent !== "definition-only") || manifest !== artifactReferenceManifest(referenceId)) return unchanged;
      ids.add(referenceId);
      references.push({ version: 1, title, referenceId, ownerInstanceId, artifactId, codeRevisionId, dataSnapshotId, snapshotAt, includeData: consent === "snapshot", machine, manifestUri: manifest, definitionUri: `omp-ui://artifacts/reference/${referenceId}/definition`, ...(consent === "snapshot" ? { dataUri: `omp-ui://artifacts/reference/${referenceId}/state` } : {}) });
    }
  } catch { return unchanged; }
  return { text: text.slice(after === text.length ? after : after + 2), references };
}

/** Model-facing, fixed: the parse requires it verbatim. Keyword-free so omp's tag-section masking stays inert inside the block. */
export const ARTIFACT_REFRESH_HINT = "The user requested refreshed data for these accepted omp-ui artifacts. Read each recorded manifest and exact provenance first; collect only the listed datasets using their recorded recipes and report exact credential-free provenance. Stage results with the omp-ui_artifact_capture tool using the exact request id recorded per entry; never apply a capture or change code.";
export const MAX_ARTIFACT_REFRESHES = 8;
const REFRESH_OPEN = "<artifact refresh>";
const REFRESH_CLOSE = "</artifact refresh>";
const REFRESH_FIELDS = ["- request: ", "  artifact: ", "  title: ", "  datasets: "] as const;

/** Builds the sole accepted refresh grammar (ADR-0092). Display fields cannot inject lines/tags. */
export function withArtifactRefreshContext(message: string, refreshes: readonly ArtifactRefreshEntry[]): string {
  if (refreshes.length === 0) return message;
  if (refreshes.length > MAX_ARTIFACT_REFRESHES) throw new ArtifactError("over-limit", "At most eight artifact refreshes may be attached");
  for (const refresh of refreshes) {
    if (refresh.version !== 1) throw new ArtifactError("unsupported-contract", "Invalid artifact refresh entry");
    assertArtifactUuid(refresh.refreshRequestId, "refreshRequestId");
    assertArtifactUuid(refresh.artifactId, "artifactId");
    if (!Array.isArray(refresh.datasetIds) || refresh.datasetIds.length === 0) throw new ArtifactError("unsupported-contract", "Invalid artifact refresh entry");
    for (const datasetId of refresh.datasetIds) assertArtifactKey(datasetId);
  }
  const entries = refreshes.flatMap(refresh => [
    `- request: ${refresh.refreshRequestId}`,
    `  artifact: ${refresh.artifactId}`,
    `  title: ${oneLine(refresh.title) || "Artifact"}`,
    // Dataset keys cannot contain commas (assertArtifactKey), so ", " is an unambiguous join.
    `  datasets: ${refresh.datasetIds.join(", ")}`,
  ]);
  const block = [REFRESH_OPEN, ARTIFACT_REFRESH_HINT, ...entries, REFRESH_CLOSE].join("\n");
  if (artifactUtf8Bytes(block) > MAX_ARTIFACT_REFERENCE_BYTES) throw new ArtifactError("over-limit", "Artifact refreshes exceed 12 KiB");
  if (splitArtifactRefreshContext(block).refreshes.length !== refreshes.length) throw new ArtifactError("unsupported-contract", "Invalid artifact refresh entry");
  return message === "" ? block : `${block}\n\n${message}`;
}

/** Removes only a proven leading block. Invalid and misplaced lookalikes remain prose. */
export function splitArtifactRefreshContext(text: string): { text: string; refreshes: ArtifactRefreshEntry[] } {
  const unchanged = { text, refreshes: [] as ArtifactRefreshEntry[] };
  if (!text.startsWith(`${REFRESH_OPEN}\n`)) return unchanged;
  const close = text.indexOf(`\n${REFRESH_CLOSE}`, REFRESH_OPEN.length);
  if (close < 0) return unchanged;
  const after = close + 1 + REFRESH_CLOSE.length;
  if (artifactUtf8Bytes(text.slice(0, after)) > MAX_ARTIFACT_REFERENCE_BYTES || (after !== text.length && !text.startsWith("\n\n", after))) return unchanged;
  const lines = text.slice(REFRESH_OPEN.length + 1, close).split("\n");
  const count = (lines.length - 1) / REFRESH_FIELDS.length;
  if (lines[0] !== ARTIFACT_REFRESH_HINT || !Number.isInteger(count) || count < 1 || count > MAX_ARTIFACT_REFRESHES) return unchanged;
  const refreshes: ArtifactRefreshEntry[] = [];
  const ids = new Set<string>();
  try {
    for (let i = 1; i < lines.length; i += REFRESH_FIELDS.length) {
      const values = REFRESH_FIELDS.map((prefix, f) => {
        const line = lines[i + f]!;
        if (!line.startsWith(prefix)) throw new Error("field order");
        const value = line.slice(prefix.length);
        if (value === "" || /[<>\r\n]/.test(value) || oneLine(value) !== value) throw new Error("display field");
        return value;
      });
      const [refreshRequestId, artifactId, title, datasets] = values as [string, string, string, string];
      assertArtifactUuid(refreshRequestId, "refreshRequestId");
      assertArtifactUuid(artifactId, "artifactId");
      const datasetIds = datasets.split(", ");
      if (datasetIds.join(", ") !== datasets) throw new Error("dataset list");
      for (const datasetId of datasetIds) assertArtifactKey(datasetId);
      if (ids.has(refreshRequestId)) return unchanged;
      ids.add(refreshRequestId);
      refreshes.push({ version: 1, refreshRequestId, artifactId, title, datasetIds });
    }
  } catch { return unchanged; }
  return { text: text.slice(after === text.length ? after : after + 2), refreshes };
}

const LEGACY_REFRESH_PREFIX = "Refresh the requested datasets for this accepted artifact in this ordinary session.";
const LEGACY_REFRESH_OPEN = "\n<artifact refresh>\nrefresh-request: ";
const LEGACY_REFRESH_CLOSE = "\n</artifact refresh>";

/**
 * Recognizes the pre-ADR-0092 wire's terminal form: text that starts with the
 * constant instruction paragraph and ends with a well-formed single-entry
 * block. Both halves are required; a lookalike missing either stays prose. The
 * interpolated dataset list between them is swallowed, never matched.
 */
export function splitLegacyArtifactRefreshRequest(text: string): { text: string; refreshRequestId: string | null } {
  const unchanged = { text, refreshRequestId: null };
  if (!text.startsWith(LEGACY_REFRESH_PREFIX) || !text.endsWith(LEGACY_REFRESH_CLOSE)) return unchanged;
  const start = text.lastIndexOf(LEGACY_REFRESH_OPEN);
  if (start < LEGACY_REFRESH_PREFIX.length) return unchanged;
  const refreshRequestId = text.slice(start + LEGACY_REFRESH_OPEN.length, text.length - LEGACY_REFRESH_CLOSE.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(refreshRequestId)) return unchanged;
  return { text: "", refreshRequestId };
}

/** Server admission shares the exact refresh → session → artifact ordering, never scans prose. */
export function parseArtifactPromptReferences(text: string): ArtifactReference[] {
  text = splitArtifactRefreshContext(text).text;
  if (text.startsWith("<session references>\n")) {
    const open = "<session references>";
    const close = text.indexOf("\n</session references>", open.length);
    if (close < 0) return [];
    const after = close + 1 + "</session references>".length;
    if (after !== text.length && !text.startsWith("\n\n", after)) return [];
    const lines = text.slice(open.length + 1, close).split("\n");
    const hint = "The user referenced these other omp-ui sessions. Each path is that session's saved transcript on this machine as of this prompt. To consult one without resuming it, call the task tool with agent \"seance\" and sourceSession set to its path; in plan mode, read the file instead.";
    if (lines[0] !== hint || lines.length < 5 || (lines.length - 1) % 4 !== 0) return [];
    const fields = ["- title: ", "  session: ", "  machine: ", "  path: "];
    for (let i = 1; i < lines.length; i++) {
      const prefix = fields[(i - 1) % 4]!;
      if (!lines[i]!.startsWith(prefix)) return [];
      const value = lines[i]!.slice(prefix.length);
      if (((i - 1) % 4 === 1 || (i - 1) % 4 === 3) && value === "") return [];
    }
    text = text.slice(after === text.length ? after : after + 2);
  }
  return splitArtifactReferenceContext(text).references;
}
