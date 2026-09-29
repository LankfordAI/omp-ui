import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalOverlayPath, writeApprovalOverlay } from "./approval-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeApprovalOverlay", () => {
  for (const mode of ["always-ask", "write", "yolo"] as const) {
    it(`writes the exact two-line overlay for ${mode}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-approval-test-"));
      dirs.push(dir);
      const file = writeApprovalOverlay(dir, mode);
      expect(file).toBe(approvalOverlayPath(dir));
      expect(fs.readFileSync(file!, "utf8")).toBe(`tools:\n  approvalMode: ${mode}\n`);
    });
  }

  it("removes the artifact on inherit and returns null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-approval-test-"));
    dirs.push(dir);
    writeApprovalOverlay(dir, "write");
    expect(writeApprovalOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(approvalOverlayPath(dir))).toBe(false);
  });

  it("replaces a stale tier rather than keeping the old file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-approval-test-"));
    dirs.push(dir);
    writeApprovalOverlay(dir, "yolo");
    writeApprovalOverlay(dir, "always-ask");
    expect(fs.readFileSync(approvalOverlayPath(dir), "utf8")).toBe(
      "tools:\n  approvalMode: always-ask\n",
    );
  });
});
