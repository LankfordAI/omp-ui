import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_COMMAND, PLAN_REVIEW_SENTINEL, PLAN_STATUS_KEY } from "./plan";
import { planExtensionPath, writePlanExtension } from "./plan-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-plan-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writePlanExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writePlanExtension(lineage);
    expect(file).toBe(planExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("emits the wire constants both sides agree on", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // A drifted constant would silently strand the renderer's routing.
    expect(source).toContain(JSON.stringify(PLAN_STATUS_KEY));
    expect(source).toContain(JSON.stringify(PLAN_REVIEW_SENTINEL));
    expect(source).toContain(JSON.stringify(PLAN_COMMAND));
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writePlanExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writePlanExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(PLAN_STATUS_KEY));
  });

  it("keeps the read-only guarantee's approval path in the generated source", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // Approval must go through omp's own validation, and exiting plan mode is
    // what restores write access — neither may be optimized away.
    expect(source).toContain("preparePlanForReview");
    expect(source).toContain("setPlanReferencePath");
    expect(source).toContain("setPlanProposalHandler");
  });

  it("writes a syntactically valid TS extension omp can transpile", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
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
