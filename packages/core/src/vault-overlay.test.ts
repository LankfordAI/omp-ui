import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { vaultOverlayPath, writeVaultOverlay } from "./vault-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-overlay-"));
  dirs.push(dir);
  return dir;
}

describe("writeVaultOverlay", () => {
  it("creates a lineage overlay that disables omp's built-in vault tools", () => {
    const lineageDir = path.join(tmp(), "lineage");
    const file = writeVaultOverlay(lineageDir);
    expect(file).toBe(path.join(lineageDir, "omp-ui-vault.yml"));
    expect(vaultOverlayPath(lineageDir)).toBe(file);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe("vault:\n  enabled: false\n");
    expect(yaml.load(text)).toEqual({ vault: { enabled: false } });
  });

  it("rewrites a stale enabled overlay on every launch", () => {
    const lineageDir = tmp();
    const file = path.join(lineageDir, "omp-ui-vault.yml");
    fs.writeFileSync(file, "vault:\n  enabled: true\n  path: stale\n");
    expect(writeVaultOverlay(lineageDir)).toBe(file);
    expect(yaml.load(fs.readFileSync(file, "utf8"))).toEqual({ vault: { enabled: false } });
    expect(writeVaultOverlay(lineageDir)).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe("vault:\n  enabled: false\n");
  });
});
