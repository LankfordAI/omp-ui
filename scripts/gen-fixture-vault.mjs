// Deterministic fixture vault for the Knowledge vault smoke (#769).
//
//   node scripts/gen-fixture-vault.mjs --out=<dir> [--notes=<N>] [--seed=761]
//
// Deletes <dir> (and its sibling <dir>-outside) and rewrites both, so a rerun
// with the same flags produces identical bytes. Prints one JSON line:
// {"out":…,"notes":<.md files outside dot folders>,"bytes":<their total size>}.
// The word source, mulberry32 and the log-normal body sizes come from the
// #754 search prototype (92ee22be:packages/desktop/prototype-vault-754/
// scripts/gen-volume-vault.mjs). Filler is built only from syllable words, so
// the planted token `zephyrine` stays in exactly one note.
import * as fs from "node:fs";
import * as path from "node:path";

function flagValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

const outFlag = flagValue("out");
if (outFlag === null || outFlag === "") {
  console.error("usage: node scripts/gen-fixture-vault.mjs --out=<dir> [--notes=<N>] [--seed=761]");
  process.exit(2);
}
const out = path.resolve(outFlag);
const requested = Number(flagValue("notes") ?? "0");
const seed = Number(flagValue("seed") ?? "761");
if (!Number.isInteger(requested) || requested < 0 || !Number.isInteger(seed)) {
  console.error("--notes and --seed must be non-negative integers");
  process.exit(2);
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// ~600 invented words from fixed syllables. The planted token (zephyrine)
// cannot be formed from these syllables.
const SYL = ["ba", "lo", "ren", "ti", "mar", "sel", "do", "kin", "va", "pel", "nor", "ast", "fen", "gri", "hol", "ul", "cam", "bri", "est", "mo", "sun", "lat", "ved", "ori"];
const WORDS = [];
for (let i = 0; i < SYL.length && WORDS.length < 600; i++) {
  for (let j = 0; j < SYL.length && WORDS.length < 600; j++) {
    if (i !== j) WORDS.push(SYL[i] + SYL[j]);
  }
}
const COMMON = ["the", "and", "of", "to", "a", "in", "for", "with", "on", "is"];
const TAGS = Array.from({ length: 30 }, (_, i) => `tag${String(i).padStart(2, "0")}-${WORDS[i * 7]}`);
const cap = (w) => w[0].toUpperCase() + w.slice(1);

// Log-normal body size: median 2 KB, p95 20 KB (sigma = ln 10 / 1.645), max 200 KB.
const MU = Math.log(2048);
const SIGMA = Math.log(10) / 1.645;
const bodySize = () => Math.min(200 * 1024, Math.max(200, Math.round(Math.exp(MU + SIGMA * gauss()))));

function sentence() {
  const words = [];
  const len = int(6, 16);
  for (let i = 0; i < len; i++) words.push(rand() < 0.3 ? pick(COMMON) : pick(WORDS));
  return cap(words.join(" ")) + ".";
}
function paragraph() {
  return Array.from({ length: int(2, 6) }, sentence).join(" ");
}

const PLANTED = "zephyrine";
const LINEAGE = "019a38bf-bbaa-7111-8123-123456789abc";
const BIG_BYTES = 2 * 1024 * 1024 - 1;
const FOLDERS = ["Projects", "Areas", "Meetings", "Reference", "Inbox"];

function stamp(project, tags = []) {
  const lines = ["---", "omp-ui: true"];
  if (project !== null) lines.push(`project: ${JSON.stringify(project)}`);
  lines.push(`lineage: ${JSON.stringify(LINEAGE)}`, "date: 2026-10-01", `tool: ${JSON.stringify("omp-ui fixture")}`);
  if (tags.length > 0) lines.push("tags:", ...tags.map((tag) => `  - ${JSON.stringify(tag)}`));
  return [...lines, "---", ""].join("\n");
}

function write(rel, text) {
  const abs = path.join(out, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const outside = path.join(out, "..", `${path.basename(out)}-outside`);
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

// ---------------------------------------------------------------- base fixture

write(".obsidian/app.json", "{}");
for (let i = 1; i <= 10; i++) {
  const title = `User Note ${String(i).padStart(2, "0")}`;
  const front = i === 4 ? "" : "---\nowner: human\n---\n\n";
  const paragraphs = [paragraph(), paragraph(), paragraph()];
  if (i === 7) paragraphs.splice(1, 0, `Remember the ${PLANTED} idea from ${pick(WORDS)}.`);
  const text = `${front}# ${title}\n\n${paragraphs.join("\n\n")}\n`;
  write(`${title}.md`, text);
  if (i === 7) write(`.trash/${title}.md`, text);
}
for (let i = 1; i <= 10; i++) {
  const title = `Stamped ${String(i).padStart(2, "0")}`;
  write(`omp-ui/Smoke/${title}.md`, `${stamp("Smoke")}${paragraph()}\n`);
}
write("omp-ui/Smoke/Smoke Index.md", `${stamp("Smoke", ["index"])}# Smoke Index\n`);
write("Foo.md", `---\nowner: human\n---\n\n# Foo\n\n${paragraph()}\n`);
write("omp-ui/Foo.md", `${stamp(null)}${paragraph()}\n`);

let big = `---\nowner: human\n---\n\n# Big\n\n${paragraph()}\n\n`;
big += "x".repeat(BIG_BYTES - Buffer.byteLength(big) - 1) + "\n";
write("Big.md", big);
const bigSize = fs.statSync(path.join(out, "Big.md")).size;
if (bigSize !== BIG_BYTES) throw new Error(`Big.md is ${bigSize} bytes, expected ${BIG_BYTES}`);

fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n\nThis note lives outside the vault.\n");
// A junction needs no symlink privilege on Windows (worktree.ts precedent); `outside` is absolute.
fs.symlinkSync(outside, path.join(out, "linked-out"), process.platform === "win32" ? "junction" : "dir");

// ---------------------------------------------------------------- volume filler

function countNotes() {
  let notes = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        notes++;
        bytes += fs.statSync(abs).size;
      }
    }
  };
  walk(out);
  return { notes, bytes };
}

const base = countNotes();
const filler = [];
const titles = new Set();
while (base.notes + filler.length < requested) {
  let title = Array.from({ length: int(2, 4) }, () => cap(pick(WORDS))).join(" ");
  if (titles.has(title)) {
    let k = 2;
    while (titles.has(`${title} ${k}`)) k++;
    title = `${title} ${k}`;
  }
  titles.add(title);
  filler.push({ title, dir: `Volume/${pick(FOLDERS)}` });
}
const allTitles = filler.map((note) => note.title);
for (const note of filler) {
  const tags = Array.from({ length: int(0, 3) }, () => pick(TAGS));
  const front = tags.length > 0 ? `---\ntags: [${[...new Set(tags)].join(", ")}]\n---\n\n` : "";
  const target = bodySize();
  const parts = [`# ${note.title}`];
  let len = parts[0].length;
  if (rand() < 0.2) {
    parts.push("## Meeting");
    len += 11;
  }
  while (len < target) {
    const p = paragraph();
    parts.push(p);
    len += p.length + 2;
  }
  const links = Array.from({ length: int(0, 8) }, () => `[[${pick(allTitles)}]]`);
  if (links.length > 0) parts.push(`Related: ${links.join(" ")}`);
  write(`${note.dir}/${note.title}.md`, front + parts.join("\n\n") + "\n");
}

const total = countNotes();
console.log(JSON.stringify({ out, notes: total.notes, bytes: total.bytes }));
