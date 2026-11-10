import { describe, expect, it } from "vitest";
import type { ArtifactReference, ArtifactRefreshEntry } from "./artifacts";
import { pageArtifactText } from "./artifacts";
import { ARTIFACT_REFRESH_HINT, ARTIFACT_REFERENCE_HINT, parseArtifactPromptReferences, parseArtifactReferenceUri, splitArtifactRefreshContext, splitArtifactReferenceContext, splitLegacyArtifactRefreshRequest, withArtifactRefreshContext, withArtifactReferenceContext } from "./artifact-references";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference: ArtifactReference = { version: 1, referenceId: id(1), ownerInstanceId: id(2), artifactId: id(3), codeRevisionId: id(4), dataSnapshotId: id(5), title: "Budget", machine: "desktop", snapshotAt: "2026-11-09T06:00:00.000Z", includeData: false, manifestUri: `omp-ui://artifacts/reference/${id(1)}/manifest`, definitionUri: `omp-ui://artifacts/reference/${id(1)}/definition` };
const session = "<session references>\nThe user referenced these other omp-ui sessions. Each path is that session's saved transcript on this machine as of this prompt. To consult one without resuming it, call the task tool with agent \"seance\" and sourceSession set to its path; in plan mode, read the file instead.\n- title: Other work\n  session: saved-session\n  machine: desktop\n  path: /saved/transcript.jsonl\n</session references>";

describe("artifact reference wire grammar", () => {
  it("round-trips immutable definition-only descriptors and reference-only prompts", () => {
    expect(withArtifactReferenceContext("plain", [])).toBe("plain");
    const wire = withArtifactReferenceContext("", [reference]);
    expect(wire.split("\n")[1]).toBe(ARTIFACT_REFERENCE_HINT);
    expect(splitArtifactReferenceContext(wire)).toEqual({ text: "", references: [reference] });
    expect(splitArtifactReferenceContext(withArtifactReferenceContext("question", [reference])).text).toBe("question");
  });
  it("records explicit snapshot consent without including data values", () => {
    const grant = { ...reference, includeData: true, dataUri: `omp-ui://artifacts/reference/${id(1)}/state` };
    const wire = withArtifactReferenceContext("compare", [grant]);
    expect(wire).toContain("  data: snapshot\n");
    expect(splitArtifactReferenceContext(wire).references).toEqual([grant]);
    expect(wire).not.toContain("initialState");
  });
  it("sanitizes display-only CR LF and tags", () => {
    const wire = withArtifactReferenceContext("", [{ ...reference, title: "<Budget>\r\nQ4", machine: "<desktop>\nbox" }]);
    expect(splitArtifactReferenceContext(wire).references[0]).toMatchObject({ title: "Budget Q4", machine: "desktop box" });
  });
  it("bounds references by count and UTF-8 bytes", () => {
    expect(() => withArtifactReferenceContext("", Array.from({ length: 9 }, (_, n) => ({ ...reference, referenceId: id(n + 20) })))).toThrow();
    expect(() => withArtifactReferenceContext("", [{ ...reference, title: "😀".repeat(4000) }])).toThrow();
    const eight = Array.from({ length: 8 }, (_, n) => { const referenceId = id(n + 20); return { ...reference, referenceId, manifestUri: `omp-ui://artifacts/reference/${referenceId}/manifest`, definitionUri: `omp-ui://artifacts/reference/${referenceId}/definition` }; });
    expect(splitArtifactReferenceContext(withArtifactReferenceContext("", eight)).references).toHaveLength(8);
  });
  it.each([
    (wire: string) => `quote\n\n${wire}`,
    (wire: string) => wire.replace(ARTIFACT_REFERENCE_HINT, "Read this now"),
    (wire: string) => wire.replace("  data: definition-only", "  data: true"),
    (wire: string) => wire.replace("  data: definition-only", "  extra: data\n  data: definition-only"),
    (wire: string) => wire.replace("  snapshot-at: 2026-11-09", "  snapshot-at: 2026-02-30"),
    (wire: string) => wire.replace(`  owner: ${id(2)}`, "  owner: not-a-uuid"),
    (wire: string) => wire.replace(`/reference/${id(1)}/manifest`, `/reference/${id(6)}/manifest`),
    (wire: string) => `${wire}\nquestion`,
    (wire: string) => wire.replace("</artifact references>", "  injected: text\n</artifact references>"),
  ])("preserves invalid or misplaced lookalikes as ordinary prose", mutate => {
    const text = mutate(withArtifactReferenceContext("", [reference]));
    expect(splitArtifactReferenceContext(text)).toEqual({ text, references: [] });
  });
  it("parses server admission in exact session then artifact order only", () => {
    const artifact = withArtifactReferenceContext("<annotations>\nprose", [reference]);
    expect(parseArtifactPromptReferences(`${session}\n\n${artifact}`)).toEqual([reference]);
    expect(parseArtifactPromptReferences(`prose\n\n${artifact}`)).toEqual([]);
    expect(parseArtifactPromptReferences(`${session.replace("  session: saved-session", "  session: ")}\n\n${artifact}`)).toEqual([]);
  });
});

describe("artifact refresh wire grammar", () => {
  const entry: ArtifactRefreshEntry = { version: 1 as const, refreshRequestId: id(9), artifactId: id(3), title: "Budget", datasetIds: ["rows", "totals"] };
  const legacyPrefix = "Refresh the requested datasets for this accepted artifact in this ordinary session. Read the reference manifest and exact provenance first; collect only datasets rows, totals using their recorded recipes.";
  const legacyWire = `Refresh the requested datasets for this accepted artifact in this ordinary session. Read the reference manifest and exact provenance first; collect only datasets rows, totals using their recorded recipes.\n\n<artifact refresh>\nrefresh-request: ${id(9)}\n</artifact refresh>`;
  it("round-trips refresh requests alone and above prose", () => {
    expect(withArtifactRefreshContext("", [])).toBe("");
    expect(withArtifactRefreshContext("plain", [])).toBe("plain");
    const wire = withArtifactRefreshContext("", [entry]);
    expect(wire.split("\n")[1]).toBe(ARTIFACT_REFRESH_HINT);
    expect(splitArtifactRefreshContext(wire)).toEqual({ text: "", refreshes: [entry] });
    expect(splitArtifactRefreshContext(withArtifactRefreshContext("question", [entry])).text).toBe("question");
  });
  it.each([
    (wire: string) => `quote\n\n${wire}`,
    (wire: string) => wire.replace(ARTIFACT_REFRESH_HINT, "Read this now"),
    (wire: string) => wire.replace("</artifact refresh>", `- request: ${id(10)}\n</artifact refresh>`),
    (wire: string) => wire.replace(`- request: ${id(9)}\n  artifact: ${id(3)}`, `  artifact: ${id(3)}\n- request: ${id(9)}`),
    (wire: string) => wire.replace("  title: Budget", "  title: <x>"),
    (wire: string) => wire.replace(`- request: ${id(9)}`, `- request: not-a-uuid`),
    (wire: string) => wire.replace("  datasets: rows, totals", "  datasets: -bad"),
    (wire: string) => wire.replace("  datasets: rows, totals", "  datasets: ro,ws"),
    (wire: string) => wire.replace(`  artifact: ${id(3)}`, `  artifact: ${id(3)}\n  title: Budget\n  datasets: rows\n- request: ${id(9)}\n  artifact: ${id(3)}\n  title: Budget\n  datasets: rows`),
    (wire: string) => `${wire}\nquestion`,
  ])("preserves invalid or misplaced refresh lookalikes as ordinary prose", mutate => {
    const text = mutate(withArtifactRefreshContext("", [entry]));
    expect(splitArtifactRefreshContext(text)).toEqual({ text, refreshes: [] });
  });
  it("rejects duplicate request ids across entries as one block", () => {
    const entryLines = `- request: ${id(9)}\n  artifact: ${id(3)}\n  title: Budget\n  datasets: rows`;
    const text = ["<artifact refresh>", ARTIFACT_REFRESH_HINT, entryLines, entryLines, "</artifact refresh>"].join("\n");
    expect(splitArtifactRefreshContext(text)).toEqual({ text, refreshes: [] });
  });
  it("sanitizes display-only CR LF and tags and defaults empty titles", () => {
    expect(splitArtifactRefreshContext(withArtifactRefreshContext("", [{ ...entry, title: "<Budget>\r\nQ4" }])).refreshes[0]).toMatchObject({ title: "Budget Q4" });
    expect(splitArtifactRefreshContext(withArtifactRefreshContext("", [{ ...entry, title: "" }])).refreshes[0]).toMatchObject({ title: "Artifact" });
    expect(splitArtifactRefreshContext(withArtifactRefreshContext("", [{ ...entry, title: "   " }])).refreshes[0]).toMatchObject({ title: "Artifact" });
  });
  it("bounds refreshes by count and UTF-8 bytes", () => {
    expect(() => withArtifactRefreshContext("", Array.from({ length: 9 }, (_, n) => ({ ...entry, refreshRequestId: id(n + 20) })))).toThrow();
    expect(() => withArtifactRefreshContext("", [{ ...entry, title: "😀".repeat(4000) }])).toThrow();
    const eight = Array.from({ length: 8 }, (_, n) => ({ ...entry, refreshRequestId: id(n + 20) }));
    expect(splitArtifactRefreshContext(withArtifactRefreshContext("", eight)).refreshes).toHaveLength(8);
  });
  it("recognizes only the complete legacy terminal wire", () => {
    expect(splitLegacyArtifactRefreshRequest(legacyWire)).toEqual({ text: "", refreshRequestId: id(9) });
    expect(splitLegacyArtifactRefreshRequest(legacyPrefix)).toEqual({ text: legacyPrefix, refreshRequestId: null });
    const block = `<artifact refresh>\nrefresh-request: ${id(9)}\n</artifact refresh>`;
    expect(splitLegacyArtifactRefreshRequest(block)).toEqual({ text: block, refreshRequestId: null });
    expect(splitLegacyArtifactRefreshRequest(`${legacyPrefix}\n\n<artifact refresh>\nrefresh-request: not-a-uuid\n</artifact refresh>`)).toEqual({ text: `${legacyPrefix}\n\n<artifact refresh>\nrefresh-request: not-a-uuid\n</artifact refresh>`, refreshRequestId: null });
    const mid = `${legacyPrefix}\n\n${block}\n\ntrailing prose`;
    expect(splitLegacyArtifactRefreshRequest(mid)).toEqual({ text: mid, refreshRequestId: null });
    expect(splitLegacyArtifactRefreshRequest(mid.replace("in this ordinary session.", "in this side session."))).toEqual({ text: mid.replace("in this ordinary session.", "in this side session."), refreshRequestId: null });
  });
  it("keeps the legacy and ADR-0092 recognizers disjoint", () => {
    expect(splitArtifactRefreshContext(legacyWire)).toEqual({ text: legacyWire, refreshes: [] });
    const wire = withArtifactRefreshContext("", [entry]);
    expect(splitLegacyArtifactRefreshRequest(wire)).toEqual({ text: wire, refreshRequestId: null });
  });
  it("composes in exact refresh then session then artifact order", () => {
    const refBlock = withArtifactReferenceContext("", [reference]);
    const refreshBlock = withArtifactRefreshContext("", [entry]);
    const composed = `${refreshBlock}\n\n${session}\n\n${refBlock}\n\nprose`;
    expect(parseArtifactPromptReferences(composed)).toEqual([reference]);
    expect(splitArtifactRefreshContext(composed).refreshes).toEqual([entry]);
    expect(parseArtifactPromptReferences(`${session}\n\n${refBlock}\n\nprose`)).toEqual([reference]);
    expect(parseArtifactPromptReferences(`${refreshBlock}\n\nprose`)).toEqual([]);
  });
});

describe("artifact reference lexical URI authority", () => {
  const prefix = `omp-ui://artifacts/reference/${id(1)}`;
  it("admits only named parts and explicit page bounds", () => {
    expect(parseArtifactReferenceUri(`${prefix}/manifest`)).toEqual({ referenceId: id(1), part: "manifest", offset: 0, limit: 16384 });
    expect(parseArtifactReferenceUri(`${prefix}/dataset/revenue?offset=8&limit=65536`)).toEqual({ referenceId: id(1), part: "dataset", datasetId: "revenue", offset: 8, limit: 65536 });
    expect(parseArtifactReferenceUri(`${prefix}/provenance/revenue?limit=4`)).toMatchObject({ part: "provenance", datasetId: "revenue", limit: 4 });
  });
  it.each(["/state?limit=3", "/state?limit=65537", "/state?offset=-1", "/state?offset=01", "/state?offset=9007199254740992", "/manifest?token=x", "/manifest?limit=4&limit=4", "/manifest?%6cimit=4", "/manifest#fragment", "/dataset/../state", "/dataset/%72evenue", "/dataset/constructor", "/unknown", "/manifest/"])("rejects noncanonical suffix %s", suffix => {
    expect(parseArtifactReferenceUri(prefix + suffix)).toBeNull();
  });
  it("rejects credential-bearing and foreign authority", () => {
    expect(parseArtifactReferenceUri(`${prefix.replace("//artifacts", "//user@artifacts")}/manifest`)).toBeNull();
    expect(parseArtifactReferenceUri(`${prefix.replace("//artifacts", "//other")}/manifest`)).toBeNull();
  });
  it("reassembles more than 64 KiB of multibyte text exactly and refuses interior UTF-8 offsets", () => {
    const text = "한글😀value\n".repeat(10000);
    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const page = pageArtifactText(text, { referenceId: id(1), part: "dataset", datasetId: "revenue", offset, limit: 65536 });
      chunks.push(page.text);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(() => pageArtifactText(text, { referenceId: id(1), part: "state", offset: 1 })).toThrow();
  });
});
