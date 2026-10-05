// PROTOTYPE (#754): throwaway.
// Model-free search benchmark and answerer smoke for the vault host tools.
// Usage:
//   node bench-search.mjs --smoke
//   node bench-search.mjs [--tiers 1000,5000,20000] [--cli-vault Obsidian[:path]]...
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readNote, searchVault, writeNote, walkNotes } from "../../src/main/prototype-vault-754/vault-fs.ts";
import { SEED_NOTES } from "./seed-vault-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../..");
const evidence = path.join(desktop, "prototype-vault-754/evidence");
const cache = path.join(process.env.HOME, ".cache/omp-ui-proto-754");
const args = process.argv.slice(2);

const baseControl = (vaultPath, vaultId, vaultName, extra = {}) => ({
  vaultPath,
  vaultId,
  vaultName,
  homeFolder: "omp-ui/",
  planGuard: true,
  searchDelayMs: 0,
  searchBackend: "fs",
  readImages: true,
  ...extra,
});

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT: ${message}`);
  console.log(`ok  ${message}`);
}

async function smoke() {
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml");
  const vault = path.join(cache, "smoke-vault");
  await fs.rm(vault, { recursive: true, force: true });
  await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
  await fs.writeFile(path.join(vault, ".obsidian/app.json"), "{}");
  for (const [rel, text] of Object.entries(SEED_NOTES)) {
    await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
    await fs.writeFile(path.join(vault, rel), text);
  }
  await fs.mkdir(path.join(vault, "Attachments"), { recursive: true });
  await fs.copyFile(path.join(desktop, "build/icon.png"), path.join(vault, "Attachments/omp-ui icon.png"));
  const control = baseControl(vault, "smoke", "smoke");
  const ctx = { project: "omp-ui", session: "tab-smoke", appVersion: "0.19.0", planEnabled: false };

  const s = await searchVault(control, "planning meeting", 10);
  assert(s.ok && s.text.includes("[[2026-09-29 omp-ui Planning Meeting]]"), "search finds the meeting note");
  assert((await searchVault(control, "   ", 10)).ok === false, "empty query is an error");

  assert((await readNote(control, "../etc/passwd")).ok === false, "read refuses ..");
  assert((await readNote(control, ".obsidian/app.json")).ok === false, "read refuses .obsidian/app.json");
  assert((await readNote(control, "/etc/passwd")).ok === false, "read refuses absolute path");
  const byTitle = await readNote(control, "desk setup");
  assert(byTitle.ok && byTitle.details.path === "Desk Setup.md", "read resolves a bare title case-insensitively");
  assert(byTitle.image !== undefined && byTitle.image.mimeType === "image/png", "read attaches the embedded image");

  const w1 = await writeNote(control, ctx, { mode: "create", title: "Plan Mode Guard", content: "Body one.", tags: ["decision"] });
  assert(w1.ok, "create writes omp-ui/Plan Mode Guard.md");
  const text = await fs.readFile(path.join(vault, "omp-ui/Plan Mode Guard.md"), "utf8");
  assert(text.startsWith("---\nomp-ui: true\n"), "stamp is the first block");
  const fmBlock = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
  const parsed = yaml.load(fmBlock);
  assert(parsed["omp-ui"] === true && parsed.project === "omp-ui" && parsed.tags[0] === "decision", "stamp parses as YAML");
  assert(text.includes("Index: [[omp-ui/omp-ui Index|omp-ui Index]]"), "note links its index");

  const dup = await writeNote(control, ctx, { mode: "create", title: "Plan Mode Guard", content: "again" });
  assert(!dup.ok && dup.text.includes("already exists"), "duplicate create is refused");
  const slash = await writeNote(control, ctx, { mode: "create", title: "../Escape", content: "x" });
  assert(!slash.ok, "title with a slash is refused");
  const outside = await writeNote(control, ctx, { mode: "append", title: "Home Lab", content: "x" });
  assert(!outside.ok && outside.text.includes("omp-ui writes only under omp-ui/"), "append outside omp-ui/ is refused");
  const guarded = await writeNote(control, { ...ctx, planEnabled: true }, { mode: "create", title: "Guarded", content: "x" });
  assert(!guarded.ok && guarded.text.startsWith("Plan mode is on in omp-ui"), "plan guard refuses the write");

  const w2 = await writeNote(control, ctx, { mode: "create", title: "Session HUD", content: "---\ntitle: x\n---\nHUD body." });
  assert(w2.ok && w2.details.collisions.includes("Session HUD.md"), "collision with the user's Session HUD is reported");
  assert(w2.details.agentFrontmatterDropped === true, "agent frontmatter is dropped");
  const index = await fs.readFile(path.join(vault, "omp-ui/omp-ui Index.md"), "utf8");
  const lines = index.split("\n").filter((l) => l.startsWith("- [["));
  assert(lines.length === 2, "index gains exactly one line per create");
  const ap = await writeNote(control, ctx, { mode: "append", title: "Plan Mode Guard", content: "More." });
  assert(ap.ok && (await fs.readFile(path.join(vault, "omp-ui/Plan Mode Guard.md"), "utf8")).endsWith("\n\nMore."), "append adds in place");
  const index2 = await fs.readFile(path.join(vault, "omp-ui/omp-ui Index.md"), "utf8");
  assert(index2 === index, "append leaves the index alone");
  console.log("smoke passed");
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { median: q(0.5), p95: q(0.95) };
}

async function bench() {
  const tiers = (args.includes("--tiers") ? args[args.indexOf("--tiers") + 1] : "1000,5000,20000").split(",").map(Number);
  const queries = ["zephyrine", "quarterly roadmap", "the", "Daily"];
  const rows = [];
  async function measure(control, label) {
    for (const query of queries) {
      const t0 = performance.now();
      const first = await searchVault(control, query, 10);
      const firstMs = performance.now() - t0;
      if (!first.ok) throw new Error(`${label} ${query}: ${first.text}`);
      const warm = [];
      for (let i = 0; i < 5; i++) {
        const t = performance.now();
        await searchVault(control, query, 10);
        warm.push(performance.now() - t);
      }
      const { median, p95 } = stats(warm);
      const row = {
        vault: label,
        backend: control.searchBackend,
        query,
        firstMs: Math.round(firstMs),
        warmMedianMs: Math.round(median),
        warmP95Ms: Math.round(p95),
        matchedFiles: first.details.matchedFiles,
        returnedFiles: first.details.returnedFiles,
        resultChars: first.details.resultChars,
        truncated: first.details.truncated,
        scannedFiles: first.details.scannedFiles,
        scannedBytes: first.details.scannedBytes,
        trashReturned: first.text.includes(".trash"),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  for (const n of tiers) {
    const vault = path.join(cache, `volume-${n}`);
    let notes = 0;
    for await (const _ of walkNotes(vault)) notes++;
    await measure(baseControl(vault, `volume-${n}`, `volume-${n}`), `volume-${n} (${notes} notes)`);
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--cli-vault") continue;
    const [name, vaultPath] = args[i + 1].split(":");
    const p = vaultPath ?? "/home/alankford/Documents/Obsidian";
    await measure(baseControl(p, name, name, { searchBackend: "cli" }), `${name} (cli)`);
    await measure(baseControl(p, name, name), `${name} (fs)`);
  }
  for (const row of rows) {
    if (row.query === "zephyrine" && row.trashReturned) throw new Error(`.trash returned in ${row.vault}`);
  }
  await fs.mkdir(evidence, { recursive: true });
  const file = path.join(evidence, "bench.json");
  const prior = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => ({ rows: [] }));
  const keep = prior.rows.filter((r) => !rows.some((n) => n.vault === r.vault && n.backend === r.backend && n.query === r.query));
  await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString(), node: process.version, rows: [...keep, ...rows] }, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

if (args.includes("--smoke")) await smoke();
else await bench();
