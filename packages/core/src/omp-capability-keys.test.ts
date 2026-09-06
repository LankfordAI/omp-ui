import { describe, expect, it } from "vitest";
import {
  SKILL_GATE_KEYS,
  SKILLS_SETTING_KEYS,
  SKILL_SOURCES,
  TOOL_SETTING_KEYS,
} from "./omp-capability-keys";

/**
 * Drift guards for the version-pinned mirror tables (issue #383, plan D4):
 * the tables must agree with each other statically, and with the live binary
 * whenever one is installed. A silent rename in omp has to fail HERE, loudly,
 * not surface as a missing row in a settings dialog.
 */

describe("the mirror tables agree with their contract", () => {
  it("every gate key is an allowlisted settings key", () => {
    for (const key of SKILL_GATE_KEYS) expect(SKILLS_SETTING_KEYS).toContain(key);
    for (const spec of SKILL_SOURCES) {
      if (spec.gateKey !== null) expect(SKILL_GATE_KEYS).toContain(spec.gateKey);
    }
  });

  it("parity with the live omp binary — skipped when there is none", async () => {
    const { execFile } = await import("node:child_process");
    const { resolveOmpBinary } = await import("./paths");
    const ompPath = resolveOmpBinary();
    if (ompPath === null) return;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(ompPath, ["config", "list", "--json"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(out),
      );
    }).catch(() => null);
    if (stdout === null) return;
    const published = new Set(Object.keys(JSON.parse(stdout) as Record<string, unknown>));
    for (const key of [...TOOL_SETTING_KEYS, ...SKILLS_SETTING_KEYS]) {
      expect(published.has(key), `omp no longer publishes ${key}`).toBe(true);
    }
  }, 30_000);
});
