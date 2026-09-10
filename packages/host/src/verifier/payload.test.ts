import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVerifierPayload } from "./payload";

const dirs: string[] = [];

function payloadDir(overrides: Partial<Record<string, string>> = {}, binary = "#!/bin/sh\nexit 0\n") {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-verifier-payload-"));
  dirs.push(resources);
  const dir = path.join(resources, "plan-verifier", "chrome-linux64");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chrome"), binary);
  const manifest = {
    version: "153.0.8010.36",
    platform: "linux",
    arch: "x64",
    executable: "chrome-linux64/chrome",
    sha256: createHash("sha256").update(binary).digest("hex"),
    ...overrides,
  };
  fs.writeFileSync(path.join(resources, "plan-verifier", "browser.manifest.json"), JSON.stringify(manifest));
  return resources;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const host = { platform: "linux" as const, arch: "x64", packaged: true };

describe("resolveVerifierPayload", () => {
  it("resolves a matching manifest to the absolute binary", () => {
    const resources = payloadDir();
    const payload = resolveVerifierPayload({ resourcesDir: resources, ...host });
    expect(payload).toMatchObject({
      version: "153.0.8010.36",
      executablePath: path.join(resources, "plan-verifier", "chrome-linux64", "chrome"),
    });
  });

  it("refuses a binary whose bytes differ from the manifest", () => {
    const resources = payloadDir({ sha256: "0".repeat(64) });
    const payload = resolveVerifierPayload({ resourcesDir: resources, ...host });
    expect(payload).toMatchObject({ available: false, reason: expect.stringContaining("hash mismatch") });
  });

  it("refuses a payload built for another platform or arch", () => {
    const resources = payloadDir({ arch: "arm64" });
    const payload = resolveVerifierPayload({ resourcesDir: resources, ...host });
    expect(payload).toMatchObject({ available: false, reason: expect.stringContaining("linux/arm64") });
  });

  it("refuses an executable path that escapes the payload directory", () => {
    const resources = payloadDir({ executable: "../../etc/passwd" });
    const payload = resolveVerifierPayload({ resourcesDir: resources, ...host });
    expect(payload).toMatchObject({ available: false, reason: expect.stringContaining("escapes") });
  });

  it("names a missing manifest", () => {
    const payload = resolveVerifierPayload({ resourcesDir: "/nonexistent", ...host });
    expect(payload).toMatchObject({ available: false, reason: expect.stringContaining("manifest unreadable") });
  });

  it("honours OMP_UI_VERIFIER_BROWSER only in a dev run", () => {
    const resources = payloadDir();
    const env = { OMP_UI_VERIFIER_BROWSER: path.join(resources, "plan-verifier") };
    expect(
      resolveVerifierPayload({ resourcesDir: "/nonexistent", env, ...host, packaged: false }),
    ).toMatchObject({ version: "153.0.8010.36" });
    expect(resolveVerifierPayload({ resourcesDir: "/nonexistent", env, ...host, packaged: true })).toMatchObject({
      available: false,
    });
  });
});
