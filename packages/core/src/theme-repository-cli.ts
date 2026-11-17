// The command line the official theme repository runs in CI (#1213), bundled
// into one file by scripts/build-theme-tool.mjs. Node only; not exported.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildThemeIndexes, checkThemeRepository, type ThemeRepositoryReport } from "./theme-repository-tool";
import { THEME_INDEX_FILE, THEME_INDEX_V2_FILE, parseThemeIndex, parseThemeIndexV2 } from "./theme-repository-format";

const USAGE = "usage: omp-ui-theme-tool <check|generate> <repository-dir>";

/** Every file under `dir`, keyed by POSIX path relative to it; the top-level .git is skipped. */
async function readRepository(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    if (relative === ".git" || relative.startsWith(".git/")) continue;
    files.set(relative, await readFile(path.join(dir, relative)));
  }
  return files;
}

/** Prints the errors and the summary; true when there are none, including the dry-run index size. */
function report(result: ThemeRepositoryReport, io: { out(line: string): void; err(line: string): void }): boolean {
  const errors = [...result.errors];
  if (errors.length === 0) {
    // The dry-run date has a constant length, so the size check is exact.
    const dry = buildThemeIndexes(result, null, "1970-01-01");
    if (!dry.ok) errors.push(dry.message);
  }
  for (const line of errors) io.err(line);
  io.out(`${result.themes.length} themes, ${errors.length} errors`);
  return errors.length === 0;
}

/** `check <dir>` or `generate <dir>`; resolves the exit code. */
export async function runThemeRepositoryCli(
  argv: readonly string[],
  io: { out(line: string): void; err(line: string): void },
): Promise<number> {
  const [command, dir, ...rest] = argv;
  if ((command !== "check" && command !== "generate") || dir === undefined || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  const files = await readRepository(dir);
  const result = checkThemeRepository(files);
  if (!report(result, io)) return 1;
  if (command === "check") return 0;

  const previous = files.get(THEME_INDEX_V2_FILE);
  const built = buildThemeIndexes(
    result,
    previous === undefined ? null : new TextDecoder().decode(previous),
    new Date().toISOString().slice(0, 10),
  );
  if (!built.ok) {
    io.err(built.message);
    return 1;
  }
  await writeFile(path.join(dir, THEME_INDEX_FILE), built.v1);
  await writeFile(path.join(dir, THEME_INDEX_V2_FILE), built.v2);
  const v1 = parseThemeIndex(built.v1);
  const v2 = parseThemeIndexV2(built.v2);
  io.out(`${THEME_INDEX_FILE}: ${v1.ok ? v1.entries.length : 0} themes`);
  io.out(`${THEME_INDEX_V2_FILE}: ${v2.ok ? v2.entries.length : 0} themes`);
  return 0;
}
