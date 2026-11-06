import { describe, expect, it } from "vitest";
import {
  SKILL_GATE_KEYS,
  SKILLS_SETTING_KEYS,
  SKILL_SOURCES,
  TOOL_SETTING_KEYS,
} from "./omp-capability-keys";
import { readInstalledOmpVersion } from "./omp-update";
import { compareVersions } from "./semver";

/**
 * Drift guards for the version-pinned mirror tables (issue #383, plan D4):
 * the tables must agree with each other statically, and with the live binary
 * whenever one is installed. A silent rename in omp has to fail HERE, loudly,
 * not surface as a missing row in a settings dialog.
 */

function assertPublishedKeys(published: ReadonlySet<string>, version: string | null): void {
  for (const key of [...TOOL_SETTING_KEYS, ...SKILLS_SETTING_KEYS]) {
    // Added in 18.17. Only a known older binary may omit this key; an
    // unavailable version must not hide drift in a current binary.
    if (key === "skills.manualSkills" && version !== null && compareVersions(version, "18.17.0") < 0) continue;
    expect(published.has(key), `omp no longer publishes ${key}`).toBe(true);
  }
}

describe("the mirror tables agree with their contract", () => {
  it("every gate key is an allowlisted settings key", () => {
    for (const key of SKILL_GATE_KEYS) expect(SKILLS_SETTING_KEYS).toContain(key);
    for (const spec of SKILL_SOURCES) {
      if (spec.gateKey !== null) expect(SKILL_GATE_KEYS).toContain(spec.gateKey);
    }
  });

  it.each([
    ["omp/18.1.10\n", true],
    ["omp/18.16.99\n", true],
    ["omp/18.17.0\n", false],
    ["omp/18.17.1\n", false],
    ["omp/18.18.0\n", false],
    ["omp/19.0.0\n", false],
    ["omp/development\n", false],
    ["unrecognized version output", false],
    [null, false],
  ])("manualSkills parity exemption for version output %s is %s", async (output, exempt) => {
    const version = await readInstalledOmpVersion("/bin/omp", async () => {
      if (output === null) throw new Error("version unavailable");
      return output;
    });
    const published = new Set<string>([...TOOL_SETTING_KEYS, ...SKILLS_SETTING_KEYS]);
    published.delete("skills.manualSkills");
    if (exempt) {
      expect(() => assertPublishedKeys(published, version)).not.toThrow();
    } else {
      expect(() => assertPublishedKeys(published, version)).toThrow("omp no longer publishes skills.manualSkills");
    }
  });

  it.each(["18.16.0", "18.17.0", null])("still checks all other keys with version %s", (version) => {
    const published = new Set<string>([...TOOL_SETTING_KEYS, ...SKILLS_SETTING_KEYS]);
    published.delete("skills.enabled");
    expect(() => assertPublishedKeys(published, version)).toThrow("omp no longer publishes skills.enabled");
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
    assertPublishedKeys(published, await readInstalledOmpVersion(ompPath));
  }, 30_000);
});
