import { describe, expect, it } from "vitest";
import { ARTIFACT_LIMITS, ArtifactError, artifactDefinitionsCompatible, normalizeArtifactAuthoringSpec, pageArtifactText, validateArtifactDatasets, validateArtifactJson, validateArtifactProvenance, validateArtifactSource, validateManagedArtifactSpec, type ArtifactProvenance, type ManagedArtifactSpec } from "./artifacts";
import { parseHtmlArtifactArgs } from "./html-artifact";

const recordedAt = "2026-11-09T00:00:00.000Z";
function provenance(): ArtifactProvenance { return { source: { kind: "manual", label: "Public observations" }, method: { kind: "manual", description: "Counted rows" }, recordedAt, captureSessionId: null, captureToolCallId: null, trust: "agent-reported", refresh: { kind: "manual", requiredSources: [] } }; }
function spec(): ManagedArtifactSpec { return { protocolVersion: 1, stateSchema: "view-v1", initialState: { selected: "all" }, datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", value: [1, 2], provenance: provenance() }] }; }

describe("artifact bounded contracts", () => {
  it("accepts named managed contracts and rejects unknown envelopes", () => {
    expect(() => validateManagedArtifactSpec(spec())).not.toThrow();
    for (const input of [{ ...spec(), protocolVersion: 2 }, { ...spec(), stateSchema: {} }, { ...spec(), initialState: [] }, { ...spec(), ignored: true }, { ...spec(), basedOn: { referenceId: "not-a-uuid" } }]) expect(() => validateManagedArtifactSpec(input)).toThrow(ArtifactError);
    expect(artifactDefinitionsCompatible({ protocolVersion: 1, stateSchema: "v1", datasets: [{ id: "a", title: "old", schema: "v1" }] }, { protocolVersion: 1, stateSchema: "v1", datasets: [{ id: "a", title: "new", schema: "v1" }] })).toBe(true);
    expect(artifactDefinitionsCompatible({ protocolVersion: 1, stateSchema: "v1", datasets: [] }, { protocolVersion: 1, stateSchema: "v2", datasets: [] })).toBe(false);
  });
  it("validates source authority UUIDs and bounded native tool identities", () => {
    const source = { ownerInstanceId: "10000000-0000-4000-8000-000000000001", lineageDir: "/trusted/project", sessionId: "20000000-0000-4000-8000-000000000001", runtimeKey: null, toolCallId: "native-call", sourceHash: "a".repeat(64), createdAt: recordedAt };
    expect(() => validateArtifactSource(source)).not.toThrow();
    for (const patch of [{ sessionId: "not-uuid" }, { runtimeKey: "not-uuid" }, { sessionId: null }, { toolCallId: "x".repeat(513) }, { sourceHash: "ABC" }]) expect(() => validateArtifactSource({ ...source, ...patch })).toThrow(ArtifactError);
  });
  it("rejects finite/prototype/cycle/accessor/sparse boundaries without invoking getters", () => {
    let invoked = false; const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { invoked = true; return 1; } });
    const arrayAccessor = Object.defineProperty([1], 0, { enumerable: true, get() { invoked = true; return 1; } });
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    const bad = [NaN, Infinity, undefined, 1n, () => 1, new Date(), Object.create({ inherited: true }), JSON.parse('{"__proto__":{}}'), { constructor: "x" }, { prototype: {} }, accessor, arrayAccessor, new Array(2), Object.assign([], { extra: true }), cyclic];
    for (const value of bad) expect(() => validateArtifactJson(value)).toThrow(ArtifactError);
    expect(invoked).toBe(false);
    let nested: unknown = 0; for (let i = 0; i < 65; i++) nested = [nested]; expect(() => validateArtifactJson(nested)).toThrow(/depth/);
    expect(() => validateArtifactJson("€".repeat(4), 10)).toThrow(/byte limit/);
  });
  it("bounds duplicate datasets, individual bytes, active totals, and provenance", () => {
    const data = spec().datasets[0]!;
    expect(() => validateArtifactDatasets([data, data])).toThrow(/Duplicate/);
    expect(() => validateArtifactDatasets([{ ...data, id: "constructor" }])).toThrow();
    expect(() => validateArtifactDatasets([{ ...data, value: "x".repeat(ARTIFACT_LIMITS.datasetBytes) }])).toThrow(/byte limit/);
    expect(() => validateArtifactDatasets(Array.from({ length: 33 }, (_, i) => ({ ...data, id: `d${i}` })))).toThrow();
    expect(() => validateArtifactProvenance({ ...provenance(), method: { kind: "query", description: "x".repeat(ARTIFACT_LIMITS.provenanceBytes) } })).toThrow();
  });
  it.each([
    { source: { kind: "url", label: "private", locator: "https://user:pass@example.com/data" } },
    { source: { kind: "url", label: "private", locator: "https://example.com/data?api_key=opaque" } },
    { source: { kind: "url", label: "private", locator: "https://example.com/callback#access_token=opaque" } },
    { source: { kind: "url", label: "private", locator: "https://example.com/#/callback?api_key=opaque" } },
    { method: { kind: "query", description: "Query", parameters: { headers: { accept: "json" } } } },
    { method: { kind: "query", description: "Query", parameters: { access_token: "opaque" } } },
    { method: { kind: "query", description: `sk-${"x".repeat(30)}` } },
  ])("rejects credentials anywhere in provenance %j", patch => { expect(() => validateArtifactProvenance({ ...provenance(), ...patch })).toThrow(ArtifactError); });
  it("stamps host facts and uses only the model-facing artifact field", () => {
    const raw = spec(); const { recordedAt: _at, captureSessionId: _session, captureToolCallId: _call, trust: _trust, ...reported } = raw.datasets[0]!.provenance;
    const authoring = { ...raw, datasets: [{ ...raw.datasets[0]!, provenance: reported }] };
    const normalized = normalizeArtifactAuthoringSpec(authoring, { recordedAt, captureSessionId: "20000000-0000-4000-8000-000000000001", captureToolCallId: "trusted-tool" });
    expect(normalized.datasets[0]!.provenance).toMatchObject({ recordedAt, captureSessionId: "20000000-0000-4000-8000-000000000001", captureToolCallId: "trusted-tool", trust: "agent-reported" });
    expect(parseHtmlArtifactArgs({ title: "Chart", html: "<p>chart</p>", artifact: authoring })).toMatchObject({ ok: true, args: { artifact: authoring } });
    expect(parseHtmlArtifactArgs({ title: "Chart", html: "<p>chart</p>", managed: authoring })).toMatchObject({ ok: false });
  });
  it("reassembles UTF-8 pages exactly and rejects split-byte offsets", () => {
    const body = "€🙂한글".repeat(10000); const referenceId = "10000000-0000-4000-8000-000000000001"; let offset = 0; let rebuilt = "";
    for (;;) { const page = pageArtifactText(body, { referenceId, part: "definition", offset, limit: 16385 }); rebuilt += page.text; if (page.nextOffset === null) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset; }
    expect(rebuilt).toBe(body);
    expect(() => pageArtifactText(body, { referenceId, part: "definition", offset: 1 })).toThrow(/boundary/);
    for (const limit of [0, 3, 65537, 1.1]) expect(() => pageArtifactText(body, { referenceId, part: "definition", limit })).toThrow();
  });
});
