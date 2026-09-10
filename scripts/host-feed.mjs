// The one renderer for `latest-host-<platform>.yml` (issue #442 §10.1). Both
// `packages/host/scripts/package-host.mjs` (the lane's own feed, beside the
// archive) and the release-manifest job (the two-arch macOS feed composed from
// the downloaded archives) go through it, so the host updater sees one shape.
//
//   node scripts/host-feed.mjs --dir <assets> --platform linux|mac|win --version <v> --out <file>
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Archive suffix per platform, mirroring package-host.mjs's LANES. */
export const HOST_ARCHIVE_EXT = {
  linux: "tar.gz",
  mac: "zip",
  win: "zip",
};

export function hostFeedName(platform) {
  return `latest-host-${platform}.yml`;
}

export function hostArchiveName(version, platform, arch) {
  return `omp-ui-host-${version}-${platform}-${arch}.${HOST_ARCHIVE_EXT[platform]}`;
}

/** The arch of a host archive named for `version`/`platform`, or null when the name is foreign. */
export function hostArchiveArch(name, version, platform) {
  const prefix = `omp-ui-host-${version}-${platform}-`;
  const suffix = `.${HOST_ARCHIVE_EXT[platform]}`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const arch = name.slice(prefix.length, name.length - suffix.length);
  return /^[a-z0-9]+$/.test(arch) ? arch : null;
}

export async function sha512Base64(file) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("base64");
}

/**
 * electron-updater's feed shape with one extra `arch` per file so a single
 * feed can list every arch of a platform. `path`/`sha512` repeat the first
 * file for readers that expect the single-file form.
 *
 * files: [{ url, sha512 (base64), size, arch }], sorted by arch.
 */
export function renderHostFeed({ version, files, releaseDate = new Date() }) {
  if (files.length === 0) throw new Error("A host feed needs at least one archive");
  const sorted = [...files].sort((left, right) => (left.arch < right.arch ? -1 : left.arch > right.arch ? 1 : 0));
  const lines = [`version: ${version}`, "files:"];
  for (const file of sorted) {
    lines.push(
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
      `    arch: ${file.arch}`,
    );
  }
  lines.push(`path: ${sorted[0].url}`, `sha512: ${sorted[0].sha512}`);
  lines.push(`releaseDate: '${releaseDate.toISOString()}'`);
  return `${lines.join("\n")}\n`;
}

/** Hashes every `omp-ui-host-<version>-<platform>-*` archive in `dir` into feed entries. */
export async function collectHostArchives(dir, version, platform) {
  const files = [];
  for (const name of await readdir(dir)) {
    const arch = hostArchiveArch(name, version, platform);
    if (arch === null) continue;
    const file = path.join(dir, name);
    files.push({ url: name, arch, size: (await stat(file)).size, sha512: await sha512Base64(file) });
  }
  return files;
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["dir", "platform", "version", "out"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Expected a value after ${flag ?? "CLI arguments"}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${flag}`);
    if (values[name] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    values[name] = value;
  }
  for (const name of allowed) {
    if (!values[name]) throw new Error(`Missing required option: --${name}`);
  }
  if (!Object.hasOwn(HOST_ARCHIVE_EXT, values.platform)) {
    throw new Error(`Unsupported platform: ${values.platform}`);
  }
  return values;
}

export async function runCli(argv) {
  const { dir, platform, version, out } = parseArguments(argv);
  const files = await collectHostArchives(dir, version, platform);
  if (files.length === 0) {
    throw new Error(`No omp-ui-host-${version}-${platform}-* archive in ${dir}`);
  }
  await writeFile(out, renderHostFeed({ version, files }));
  process.stdout.write(`${out}: ${files.map(({ arch }) => arch).join(", ")}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
