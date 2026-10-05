// PROTOTYPE (#754): throwaway.
// Appends through the prototype's writeNote (the same code the host tool runs)
// while Obsidian has the note open, then polls Obsidian every 100 ms until the
// open view shows the new line. Usage: node append-latency.mjs <source|preview>
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeNote } from "../../src/main/prototype-vault-754/vault-fs.ts";

const CLI = "/home/alankford/.local/bin/obsidian";
const TITLE = "Knowledge Home Is A ProjectRecord Field";
const want = process.argv[2];
const out = join(dirname(fileURLToPath(import.meta.url)), "../evidence/obsidian");
mkdirSync(out, { recursive: true });
const ev = (code) =>
  execFileSync(CLI, ["vault=Obsidian", "eval", `code=${code}`], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .replace(/^=> /, "")
    .trim();
const leaf = "app.workspace.getMostRecentLeaf()";
const mode = ev(`${leaf}.view.getMode()`);
if (mode !== want) {
  execFileSync(CLI, ["vault=Obsidian", "command", "id=markdown:toggle-preview"], { stdio: "ignore" });
}
const needle = `Latency probe ${want} ${Date.now()}`;
const state = () =>
  JSON.parse(
    ev(
      `JSON.stringify({mode:${leaf}.view.getMode(), shown:${leaf}.view.containerEl.innerText.includes(${JSON.stringify(needle)}), editor:${leaf}.view.editor?.getValue().includes(${JSON.stringify(needle)}), cursor:${leaf}.view.editor?.getCursor(), scroll:${leaf}.view.getScroll?.(), notices:[...document.querySelectorAll('.notice')].map(n=>n.innerText)})`,
    ),
  );
const before = state();
const control = {
  vaultPath: "/home/alankford/Documents/Obsidian",
  vaultId: "ee8bdab8baa42089",
  vaultName: "Obsidian",
  homeFolder: "omp-ui/",
  planGuard: true,
  searchDelayMs: 0,
  searchBackend: "fs",
  readImages: true,
};
const t0 = performance.now();
const res = await writeNote(
  control,
  { project: "omp-ui", session: "append-latency", appVersion: "0.19.0", planEnabled: false },
  { mode: "append", title: TITLE, content: needle },
);
let shownMs = null;
let last = before;
const notices = new Set();
while (performance.now() - t0 < 15000) {
  last = state();
  for (const n of last.notices) notices.add(n);
  if (last.shown) {
    shownMs = Math.round(performance.now() - t0);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
const png = join(out, `latency-${want}.png`);
execFileSync(CLI, ["vault=Obsidian", "dev:screenshot", `path=${png}`], { stdio: "ignore" });
const row = { at: new Date().toISOString(), want, needle, ok: res.ok, before, after: last, shownMs, notices: [...notices], png };
appendFileSync(join(out, "append-latency.jsonl"), `${JSON.stringify(row)}\n`);
console.log(JSON.stringify(row));
