import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { artifactSourceHash, readHistoricalArtifactSource } from "./artifact-source";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(args: unknown, options: { sessionId?: string; toolCallId?: string; isError?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-source-")); roots.push(root);
  const file = path.join(root, "session.jsonl");
  const sessionId = options.sessionId ?? "session-actual";
  const toolCallId = options.toolCallId ?? "native-tool-actual";
  fs.writeFileSync(file, `${JSON.stringify({ type: "title", title: "optional slot" })}\n${JSON.stringify({ type: "session", id: sessionId })}\n`);
  const call = JSON.stringify({ type: "message", timestamp: "2026-11-09T01:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "omp-ui_render_html", arguments: args }] } });
  const result = JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId, toolName: "omp-ui_render_html", isError: options.isError ?? false, content: [] } });
  return { file, sessionId, toolCallId, sourceHash: artifactSourceHash(args), append: () => fs.appendFileSync(file, `${call}\n${result}\n`) };
}

describe("historical artifact source authority", () => {
  it("requires the exact native session header, tool ID, canonical arguments and successful result", async () => {
    const args = { title: "Trusted", html: "<b>real</b>", nested: { b: 2, a: 1 } };
    const source = fixture(args); source.append();
    expect((await readHistoricalArtifactSource(source)).args).toEqual(args);
    expect(artifactSourceHash({ html: args.html, nested: { a: 1, b: 2 }, title: args.title })).toBe(source.sourceHash);
    await expect(readHistoricalArtifactSource({ ...source, sessionId: "other" })).rejects.toThrow("header");
    await expect(readHistoricalArtifactSource({ ...source, toolCallId: "host-answer-id" })).rejects.toThrow("not found");
    await expect(readHistoricalArtifactSource({ ...source, sourceHash: "a".repeat(64) })).rejects.toThrow("arguments");
    const failed = fixture(args, { isError: true }); failed.append();
    await expect(readHistoricalArtifactSource(failed)).rejects.toThrow(/successful/i);
  });

  it.each([false, true])("streams a target over 8 MiB after an oversized unrelated record (gzip=%s)", async (gzip) => {
    const args = { title: "Large managed inputs", html: "<b>large</b>", managed: { datasets: ["a".repeat(5 * 1024 * 1024), "b".repeat(5 * 1024 * 1024)] } };
    const source = fixture(args);
    fs.appendFileSync(source.file, '{"type":"message","message":{"role":"user","content":"');
    const chunk = "x".repeat(1024 * 1024);
    for (let n = 0; n < 70; n++) fs.appendFileSync(source.file, chunk);
    fs.appendFileSync(source.file, '"}}\n'); source.append();
    const file = gzip ? `${source.file}.gz` : source.file;
    if (gzip) await pipeline(fs.createReadStream(source.file), createGzip(), fs.createWriteStream(file));
    const result = await readHistoricalArtifactSource({ ...source, file });
    expect(result.args).toEqual(args);
  }, 60_000);

  it("rejects target records above 64 MiB and honors cancellation", async () => {
    const source = fixture({ title: "Too big", html: "x", payload: "x".repeat(65 * 1024 * 1024) }); source.append();
    await expect(readHistoricalArtifactSource(source)).rejects.toThrow("64 MiB");
    const controller = new AbortController(); controller.abort();
    await expect(readHistoricalArtifactSource({ ...source, signal: controller.signal })).rejects.toThrow();
  }, 60_000);

  it("rejects duplicate native call identities and unsafe canonical JSON", async () => {
    const source = fixture({ title: "A", html: "a" }); source.append(); source.append();
    await expect(readHistoricalArtifactSource(source)).rejects.toThrow(/duplicate/i);
    expect(() => artifactSourceHash(JSON.parse('{"__proto__":1}'))).toThrow(/unsafe/i);
    expect(() => artifactSourceHash({ value: Number.NaN })).toThrow("finite");
  });
});
