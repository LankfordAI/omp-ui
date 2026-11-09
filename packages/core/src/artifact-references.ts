import { ArtifactError, assertArtifactKey, assertArtifactUuid, artifactUtf8Bytes, type ArtifactReference, type ArtifactReferencePartRequest } from "./artifacts";

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

/** Server admission shares the exact session → artifact ordering, never scans prose. */
export function parseArtifactPromptReferences(text: string): ArtifactReference[] {
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
