import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_ARTIFACT_BYTE_LIMIT } from "./limits";
import { readConfinedPlanFile } from "./plan-file";

const dirs: string[] = [];

async function tmpRoot(): Promise<string> {
  // macOS/Windows tmpdirs are symlinks; realpath so containment comparisons
  // match what the reader itself computes.
  const base = await fs.promises.realpath(os.tmpdir());
  const dir = await fs.promises.mkdtemp(path.join(base, "omp-ui-plan-file-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

describe("readConfinedPlanFile", () => {
  it("returns the exact bytes and their SHA-256", async () => {
    const root = await tmpRoot();
    const file = path.join(root, "plan.html");
    const text = "<!doctype html>\n<html><body><p>héllo — $& $' \u{1f600}</p></body></html>";
    await fs.promises.writeFile(file, text, "utf8");

    const read = await readConfinedPlanFile(root, file);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.text).toBe(text);
    expect(read.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(read.sourceHash).toBe(
      createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    );
    expect(read.bytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("hashes bytes, not characters: the hash is of the file's content", async () => {
    const root = await tmpRoot();
    const file = path.join(root, "plan.html");
    await fs.promises.writeFile(file, "<p>ä</p>", "utf8");
    const first = await readConfinedPlanFile(root, file);
    await fs.promises.writeFile(file, "<p>a</p>", "utf8");
    const second = await readConfinedPlanFile(root, file);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.sourceHash).not.toBe(second.sourceHash);
  });

  it("rejects a path outside the lineage root", async () => {
    const root = await tmpRoot();
    const siblingDir = await tmpRoot();
    const sibling = path.join(siblingDir, "plan.html");
    await fs.promises.writeFile(sibling, "<p>x</p>", "utf8");
    expect(await readConfinedPlanFile(root, sibling)).toEqual({ ok: false, reason: "outside" });
    // Dot-dot traversal of that sibling spells the same failure.
    expect(
      await readConfinedPlanFile(
        root,
        path.join(root, "..", path.basename(siblingDir), "plan.html"),
      ),
    ).toEqual({ ok: false, reason: "outside" });
  });

  it("fails closed on a symlink that escapes the root", async () => {
    const root = await tmpRoot();
    const outside = path.join(await tmpRoot(), "secret.txt");
    await fs.promises.writeFile(outside, "<p>not yours</p>", "utf8");
    const link = path.join(root, "plan.html");
    await fs.promises.symlink(outside, link);
    expect(await readConfinedPlanFile(root, link)).toEqual({ ok: false, reason: "outside" });
  });

  it("judges an in-root symlink by its target", async () => {
    const root = await tmpRoot();
    const real = path.join(root, "target.html");
    const text = "<p>moved</p>";
    await fs.promises.writeFile(real, text, "utf8");
    const link = path.join(root, "plan.html");
    await fs.promises.symlink(real, link);

    const read = await readConfinedPlanFile(root, link);
    expect(read.ok && read.text).toBe(text);
  });

  it("reports a missing artifact as unreadable, not outside", async () => {
    const root = await tmpRoot();
    expect(await readConfinedPlanFile(root, path.join(root, "gone.html"))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("never streams a directory or a missing root", async () => {
    const root = await tmpRoot();
    const sub = path.join(root, "specs");
    await fs.promises.mkdir(sub);
    expect(await readConfinedPlanFile(root, sub)).toEqual({ ok: false, reason: "unreadable" });
    const missing = path.join(root, "nope");
    expect(await readConfinedPlanFile(missing, path.join(missing, "plan.html"))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("refuses a file at the byte limit plus one — a cap hit is not truncation", async () => {
    const root = await tmpRoot();
    const file = path.join(root, "plan.html");
    // Sparse: sized without paying 8 MiB of writes.
    await fs.promises.writeFile(file, "");
    await fs.promises.truncate(file, PLAN_ARTIFACT_BYTE_LIMIT + 1);
    expect(await readConfinedPlanFile(root, file)).toEqual({ ok: false, reason: "over-limit" });
  });
});
