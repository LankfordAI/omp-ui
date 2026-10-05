// PROTOTYPE (#754): throwaway.
// Seeds invented personal notes at the top level of a vault. Never overwrites:
// every write uses flag "wx", and an existing file is reported and kept.
// Usage: node seed-vault.mjs [--vault <path>] [--restore "Desk Setup.md"]
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_NOTES } from "./seed-vault-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDesktop = path.resolve(here, "../..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const vault = flag("--vault") ?? "/home/alankford/Documents/Obsidian";
const restore = flag("--restore");

async function writeNew(rel, data) {
  const abs = path.join(vault, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, data, { flag: "wx" });
    console.log(`wrote ${rel}`);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      console.log(`kept existing ${rel}`);
      return false;
    }
    throw error;
  }
}

if (restore !== null) {
  // Restore one seed note a run changed: only when it still carries the seed marker.
  const abs = path.join(vault, restore);
  const current = await fs.readFile(abs, "utf8").catch(() => null);
  if (current !== null && !current.includes("prototype-754-seed: true")) {
    throw new Error(`${restore} is not a seed note; refusing to restore`);
  }
  await fs.writeFile(abs, SEED_NOTES[restore]);
  console.log(`restored ${restore}`);
} else {
  for (const [rel, text] of Object.entries(SEED_NOTES)) await writeNew(rel, text);
  await writeNew("Attachments/omp-ui icon.png", await fs.readFile(path.join(repoDesktop, "build/icon.png")));
}
