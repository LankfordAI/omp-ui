import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLATFORM_KINDS = {
  linux: ["appimage"],
  mac: ["dmg", "zip"],
  win: ["nsis"],
};

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linuxArchNames(arch) {
  switch (arch) {
    case "x64":
      return ["x64", "amd64", "x86_64"];
    case "arm64":
      return ["arm64", "aarch64"];
    case "armv7l":
      return ["armv7l", "armhf"];
    default:
      return [arch];
  }
}

function classify(file, target) {
  const version = escapeRegExp(target.version);

  for (const arch of target.arches) {
    const escapedArch = escapeRegExp(arch);
    if (target.platform === "mac") {
      const match = file.name.match(
        new RegExp(`^omp-ui-${version}-mac-preview-${escapedArch}\\.(dmg|zip)$`),
      );
      if (match) return { arch, kind: match[1] };
    }

    if (
      target.platform === "win" &&
      new RegExp(
        `^omp-ui-${version}-windows-preview-${escapedArch}-setup\\.exe$`,
      ).test(file.name)
    ) {
      return { arch, kind: "nsis" };
    }

    if (target.platform === "linux") {
      const aliases = linuxArchNames(arch).map(escapeRegExp).join("|");
      if (
        new RegExp(
          `^omp-ui[-_]${version}(?:[-_.](?:${aliases}))?\\.AppImage$`,
          "i",
        ).test(file.name)
      ) {
        if (
          target.arches.length > 1 &&
          !new RegExp(`(?:^|[-_.])(?:${aliases})(?:[-_.]|$)`, "i").test(file.name)
        ) {
          continue;
        }
        return { arch, kind: "appimage" };
      }
      if (
        new RegExp(`^omp-ui[-_]${version}[-_](?:${aliases})\\.deb$`, "i").test(
          file.name,
        )
      ) {
        return { arch, kind: "deb" };
      }
    }
  }

  return null;
}

function assertTarget(target) {
  if (!Object.hasOwn(PLATFORM_KINDS, target?.platform)) {
    throw new Error(`Unsupported platform: ${target?.platform ?? ""}`);
  }
  if (typeof target.version !== "string" || target.version.length === 0) {
    throw new Error("Target version is required");
  }
  if (!Array.isArray(target.arches) || target.arches.length === 0) {
    throw new Error("Target arches are required");
  }
  if (target.arches.some((arch) => typeof arch !== "string" || arch.length === 0)) {
    throw new Error("Target arches must be non-empty strings");
  }
  if (new Set(target.arches).size !== target.arches.length) {
    throw new Error("Target arches contain duplicates");
  }
}

export function planReleaseManifest(files, target) {
  assertTarget(target);

  const duplicateNames = files
    .map(({ name }) => name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate artifact: ${duplicateNames.sort()[0]}`);
  }

  const artifacts = [];
  const seen = new Map();
  for (const file of files) {
    if (
      typeof file?.name !== "string" ||
      file.name.length === 0 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("Files must have a name and a non-negative integer size");
    }
    const classification = classify(file, target);
    if (!classification) continue;

    const key = `${classification.arch}:${classification.kind}`;
    const previous = seen.get(key);
    if (previous) {
      throw new Error(
        `Duplicate ${target.platform} ${classification.kind} artifact for ${classification.arch}: ${previous}, ${file.name}`,
      );
    }
    seen.set(key, file.name);
    artifacts.push({
      name: file.name,
      size: file.size,
      platform: target.platform,
      arch: classification.arch,
      kind: classification.kind,
    });
  }

  const missing = [];
  for (const arch of target.arches) {
    for (const kind of PLATFORM_KINDS[target.platform]) {
      if (!seen.has(`${arch}:${kind}`)) missing.push(`${arch} ${kind}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing ${target.platform} artifacts: ${missing.join(", ")}`);
  }

  artifacts.sort(compareNames);
  const checksumInputs = artifacts.map(({ name }) => name);
  let latestMac = null;
  if (target.platform === "mac") {
    const byArchAndKind = new Map(
      artifacts.map((artifact) => [`${artifact.arch}:${artifact.kind}`, artifact]),
    );
    const macFiles = target.arches.flatMap((arch) => [
      byArchAndKind.get(`${arch}:dmg`),
      byArchAndKind.get(`${arch}:zip`),
    ]);
    latestMac = {
      version: target.version,
      files: macFiles.map(({ name, size }) => ({ url: name, size })),
      path: macFiles[0].name,
    };
  }

  return { artifacts, checksumInputs, latestMac };
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["dir", "platform", "version", "arches", "out-dir"]);
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
  return {
    dir: values.dir,
    outDir: values["out-dir"],
    target: {
      platform: values.platform,
      version: values.version,
      arches: values.arches.split(",").map((arch) => arch.trim()),
    },
  };
}

async function sha512(file) {
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("base64");
}

async function renderLatestMac(plan, dir) {
  const files = [];
  for (const file of plan.latestMac.files) {
    files.push({ ...file, sha512: await sha512(path.join(dir, file.url)) });
  }
  const primary = files.find(({ url }) => url === plan.latestMac.path);
  const lines = [`version: ${plan.latestMac.version}`, "files:"];
  for (const file of files) {
    lines.push(
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    );
  }
  lines.push(`path: ${primary.url}`, `sha512: ${primary.sha512}`);
  lines.push(`releaseDate: '${new Date().toISOString()}'`);
  return `${lines.join("\n")}\n`;
}

export async function runCli(argv) {
  const { dir, outDir, target } = parseArguments(argv);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => ({
        name: entry.name,
        size: (await stat(path.join(dir, entry.name))).size,
      })),
  );
  const plan = planReleaseManifest(files, target);

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "checksum-inputs.txt"),
    `${plan.checksumInputs.join("\n")}\n`,
  );
  if (plan.latestMac) {
    await writeFile(
      path.join(outDir, "latest-mac.yml"),
      await renderLatestMac(plan, dir),
    );
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
