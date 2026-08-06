import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forkSessionFile } from "./fork";

const SOURCE_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const FORK_ID = "019faeab-cc7b-7000-8bfc-0000000000ff";
const NOW = new Date("2026-08-06T05:00:00.000Z");

const tmp: string[] = [];
function setup(lines: string[]): { source: string; destDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-fork-"));
  tmp.push(base);
  const source = path.join(base, `2026-08-04T14-33-00-565Z_${SOURCE_ID}.jsonl`);
  fs.writeFileSync(source, `${lines.join("\n")}\n`);
  return { source, destDir: path.join(base, "fork-lineage") };
}

afterEach(() => {
  while (tmp.length > 0) fs.rmSync(tmp.pop()!, { recursive: true, force: true });
});

const HEADER = `{"type":"session","version":3,"id":"${SOURCE_ID}","timestamp":"2026-08-04T14:33:00.565Z","cwd":"/p"}`;
const MESSAGE = `{"type":"message","id":"abc123","parentId":null,"timestamp":"2026-08-04T14:33:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`;

describe("forkSessionFile", () => {
  it("copies every entry and re-heads the fork with the new id and parent linkage", async () => {
    const { source, destDir } = setup([HEADER, MESSAGE]);

    const forked = await forkSessionFile(source, destDir, FORK_ID, NOW);

    expect(path.basename(forked)).toBe(`2026-08-06T05-00-00-000Z_${FORK_ID}.jsonl`);
    const lines = fs.readFileSync(forked, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "session",
      id: FORK_ID,
      timestamp: NOW.toISOString(),
      parentSession: source,
      cwd: "/p",
    });
    // Entries below the header are byte-identical — full context, no rewrite.
    expect(lines[1]).toEqual(JSON.parse(MESSAGE));
  });

  it("drops a torn tail line left by a live append", async () => {
    const { source, destDir } = setup([HEADER, MESSAGE]);
    fs.appendFileSync(source, `{"type":"message","id":"torn"`); // no newline, partial JSON

    const forked = await forkSessionFile(source, destDir, FORK_ID, NOW);

    const lines = fs.readFileSync(forked, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("refuses a file with no session header", async () => {
    const { source, destDir } = setup([MESSAGE]);
    await expect(forkSessionFile(source, destDir, FORK_ID, NOW)).rejects.toThrow(/no session header/);
    expect(fs.existsSync(destDir)).toBe(false);
  });

  it("refuses an unparseable line rather than shipping a corrupt fork", async () => {
    const { source, destDir } = setup([HEADER, "not json"]);
    await expect(forkSessionFile(source, destDir, FORK_ID, NOW)).rejects.toThrow();
  });
});
