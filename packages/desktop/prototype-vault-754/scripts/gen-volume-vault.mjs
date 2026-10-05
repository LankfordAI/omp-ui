// PROTOTYPE (#754): throwaway.
// Deterministic synthetic vault for the search benchmark.
// Usage: node gen-volume-vault.mjs --notes N --out <dir> [--seed 754]
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const N = Number(flag("--notes", "1000"));
const out = path.resolve(flag("--out", `${process.env.HOME}/.cache/omp-ui-proto-754/volume-${N}`));
const seed = Number(flag("--seed", "754"));

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

// ~600 invented words from fixed syllables. The planted tokens (zephyrine,
// quarterly, roadmap) cannot be formed from these syllables.
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

const DAILY = 365;
const FOLDERS = ["Projects", "Areas", "Meetings", "Reference", "Inbox"];
const titles = new Set();
const notes = [];
const day0 = Date.UTC(2026, 0, 1);
for (let d = 0; d < Math.min(DAILY, N); d++) {
  const iso = new Date(day0 + d * 86400000).toISOString().slice(0, 10);
  titles.add(iso);
  notes.push({ title: iso, dir: "Daily/2026" });
}
const subs = Array.from({ length: 12 }, () => cap(pick(WORDS)));
while (notes.length < N) {
  let title = Array.from({ length: int(2, 4) }, () => cap(pick(WORDS))).join(" ");
  if (titles.has(title)) {
    let k = 2;
    while (titles.has(`${title} ${k}`)) k++;
    title = `${title} ${k}`;
  }
  titles.add(title);
  let dir = "";
  if (rand() >= 0.2) {
    dir = pick(FOLDERS);
    const depth = int(0, 2);
    for (let i = 0; i < depth; i++) dir += `/${pick(subs)}`;
  }
  notes.push({ title, dir });
}
const allTitles = notes.map((n) => n.title);

// Planted words: zephyrine in exactly 3 notes (+ .trash), quarterly roadmap in ~5%.
const nonDaily = notes.slice(Math.min(DAILY, N));
const zephyr = new Set();
while (zephyr.size < 3) zephyr.add(pick(nonDaily.length > 0 ? nonDaily : notes));
for (const note of notes) note.roadmap = rand() < 0.05;

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, ".obsidian"), { recursive: true });
await fs.writeFile(path.join(out, ".obsidian/app.json"), "{}");
await fs.mkdir(path.join(out, ".trash"), { recursive: true });
await fs.writeFile(path.join(out, ".trash/Old Note.md"), "# Old Note\n\nThe zephyrine draft, deleted.\n");
await fs.mkdir(path.join(out, "Attachments"), { recursive: true });
const icon = await fs.readFile(path.join(desktop, "build/icon.png"));
for (let i = 0; i < 50; i++) await fs.writeFile(path.join(out, `Attachments/Image ${i + 1}.png`), icon);

let totalBytes = 0;
const sizes = [];
for (const note of notes) {
  const tags = Array.from({ length: int(0, 3) }, () => pick(TAGS));
  const fmText = tags.length > 0 ? `---\ntags: [${[...new Set(tags)].join(", ")}]\n---\n\n` : "";
  const target = bodySize();
  const parts = [`# ${note.title}`];
  let len = parts[0].length;
  if (rand() < 0.2) {
    parts.push("## Meeting");
    len += 11;
  }
  if (note.roadmap) {
    const line = `Discussed the quarterly roadmap for ${pick(WORDS)}.`;
    parts.push(line);
    len += line.length;
  }
  if (zephyr.has(note)) {
    const line = `Remember the zephyrine idea from ${pick(WORDS)}.`;
    parts.push(line);
    len += line.length;
  }
  while (len < target) {
    const p = paragraph();
    parts.push(p);
    len += p.length + 2;
  }
  const links = Array.from({ length: int(0, 8) }, () => `[[${pick(allTitles)}]]`);
  if (links.length > 0) parts.push(`Related: ${links.join(" ")}`);
  const text = fmText + parts.join("\n\n") + "\n";
  const dir = path.join(out, note.dir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${note.title}.md`), text);
  totalBytes += Buffer.byteLength(text);
  sizes.push(Buffer.byteLength(text));
}
sizes.sort((a, b) => a - b);
const summary = {
  notes: notes.length,
  bytes: totalBytes,
  mb: +(totalBytes / 1e6).toFixed(1),
  medianBytes: sizes[Math.floor(sizes.length / 2)],
  p95Bytes: sizes[Math.floor(sizes.length * 0.95)],
  maxBytes: sizes[sizes.length - 1],
  zephyrineNotes: [...zephyr].map((n) => (n.dir ? `${n.dir}/` : "") + `${n.title}.md`),
  roadmapNotes: notes.filter((n) => n.roadmap).length,
  seed,
  out,
};
const evidence = path.join(desktop, "prototype-vault-754/evidence");
await fs.mkdir(evidence, { recursive: true });
await fs.writeFile(path.join(evidence, `volume-${N}.json`), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
