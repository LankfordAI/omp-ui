import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { ADVISOR_STATS_COMMAND, ADVISOR_STATS_KEY } from "./advisor-stats";
import {
  advisorStatsExtensionPath,
  writeAdvisorStatsExtension,
} from "./advisor-stats-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-advstats-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeAdvisorStatsExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeAdvisorStatsExtension(lineage);
    expect(file).toBe(advisorStatsExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("emits the wire constants both sides agree on", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // A drifted constant would silently strand the renderer's routing.
    expect(source).toContain(JSON.stringify(ADVISOR_STATS_KEY));
    expect(source).toContain(JSON.stringify(ADVISOR_STATS_COMMAND));
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writeAdvisorStatsExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writeAdvisorStatsExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(ADVISOR_STATS_KEY));
  });

  it("reads cost and context through omp's public getAdvisorStats surface", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // The whole point: cost + context live on AgentSession.getAdvisorStats.
    expect(source).toContain("getAdvisorStats");
    expect(source).toContain("contextWindow");
    expect(source).toContain("contextTokens");
    expect(source).toContain("cost");
  });

  it("degrades to a published unavailable reason when the surface is missing", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    expect(source).toContain("available: false");
    expect(source).toContain("missing getAdvisorStats");
  });

  it("writes a syntactically valid TS extension omp can transpile", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // Substring checks can't catch a broken template; the file omp loads must
    // actually be valid TypeScript, or every session with an advisor would
    // reject the -e arg at startup.
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    const errors = (diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((e) => String(e.messageText))).toEqual([]);
  });
});
