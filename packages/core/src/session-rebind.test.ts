import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebindSessionCwd } from "./session-rebind";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** omp's fixed-width title slot: exactly 256 bytes including the newline. */
function titleSlot(title: string): string {
  const entry = { type: "title", v: 1, title, source: "user", pad: "" };
  const base = JSON.stringify(entry);
  const pad = 255 - base.length;
  return JSON.stringify({ ...entry, pad: " ".repeat(Math.max(0, pad)) });
}

const HEADER = (cwd: string): string =>
  `{"type":"session","version":3,"id":"019faeab-cc7b-7000-8bfc-67242a2869d8","timestamp":"2026-07-29T16:18:42.427Z","cwd":${JSON.stringify(cwd)},"title":"t"}`;
const MESSAGE =
  '{"type":"message","id":"abc123","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

/** Writes a session file with the title slot, header, and one message. */
function sessionFile(cwd: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebind-test-"));
  dirs.push(dir);
  const file = path.join(dir, "2026-07-29T16-18-42-427Z_019faeab.jsonl");
  fs.writeFileSync(file, `${titleSlot("A session")}\n${HEADER(cwd)}\n${MESSAGE}\n`, "utf8");
  return file;
}

describe("rebindSessionCwd", () => {
  it("points the header at the new working tree and leaves every other line alone", async () => {
    const file = sessionFile("/worktrees/alpha/omp-feature");
    const before = fs.readFileSync(file, "utf8").split("\n");

    expect(await rebindSessionCwd(file, "/project")).toBe(true);

    const after = fs.readFileSync(file, "utf8").split("\n");
    expect(JSON.parse(after[1]!).cwd).toBe("/project");
    // The title slot's byte length is load bearing: omp overwrites it in place.
    expect(after[0]).toBe(before[0]);
    expect(Buffer.byteLength(after[0]!, "utf8")).toBe(Buffer.byteLength(before[0]!, "utf8"));
    expect(after[2]).toBe(before[2]);
    expect(after.at(-1)).toBe("");
    // Header fields other than cwd survive, in order.
    expect(Object.keys(JSON.parse(after[1]!))).toEqual([
      "type",
      "version",
      "id",
      "timestamp",
      "cwd",
      "title",
    ]);
  });

  it("is a no-op when the header already names that directory", async () => {
    const file = sessionFile("/project");
    const before = fs.readFileSync(file, "utf8");

    expect(await rebindSessionCwd(file, "/project")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("leaves a file with no session header untouched", async () => {
    const file = sessionFile("/project");
    fs.writeFileSync(file, `${MESSAGE}\n`, "utf8");

    expect(await rebindSessionCwd(file, "/elsewhere")).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(`${MESSAGE}\n`);
  });

  it("leaves an unparseable header untouched rather than throwing", async () => {
    const file = sessionFile("/project");
    fs.writeFileSync(file, `{"type":"session","cwd":\n`, "utf8");

    expect(await rebindSessionCwd(file, "/elsewhere")).toBe(false);
  });

  it("leaves no temp file behind", async () => {
    const file = sessionFile("/worktrees/alpha/omp-feature");
    await rebindSessionCwd(file, "/project");

    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
});
