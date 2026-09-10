import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The packaged Chrome for Testing the verifier drives (issue #442 §8.3).
 * Never a system browser, never a runtime download: the binary ships in the
 * application's resources beside a manifest the fetch script wrote, and the
 * host refuses to run anything whose bytes do not match that manifest.
 */
export interface VerifierPayload {
  executablePath: string;
  version: string;
  sha256: string;
  platform: string;
  arch: string;
}

export interface VerifierUnavailable {
  available: false;
  reason: string;
}

/** Written by `scripts/fetch-verifier-browser.mjs` beside the unpacked browser. */
interface BrowserManifest {
  version: string;
  platform: string;
  arch: string;
  executable: string;
  sha256: string;
}

export interface ResolveVerifierPayloadOptions {
  /** `process.resourcesPath` in a package; any directory with a `plan-verifier/` child in dev. */
  resourcesDir: string;
  env?: NodeJS.ProcessEnv;
  packaged: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
}

export const VERIFIER_BROWSER_ENV = "OMP_UI_VERIFIER_BROWSER";

/** 1 MiB: the binary is ~200 MB, so the hash streams rather than slurps. */
const HASH_CHUNK = 1024 * 1024;

export function resolveVerifierPayload(
  opts: ResolveVerifierPayloadOptions,
): VerifierPayload | VerifierUnavailable {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  // A dev override only ever applies to a dev run: a package ignores the
  // environment so nothing outside the resources dir can name the binary.
  const override = opts.packaged ? undefined : env[VERIFIER_BROWSER_ENV];
  const dir =
    override !== undefined && override !== ""
      ? path.resolve(override)
      : path.join(opts.resourcesDir, "plan-verifier");
  const manifestPath = path.join(dir, "browser.manifest.json");
  let manifest: BrowserManifest;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { available: false, reason: `verifier browser manifest unreadable at ${manifestPath}: ${detail}` };
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    return {
      available: false,
      reason: `verifier browser built for ${manifest.platform}/${manifest.arch}, host is ${platform}/${arch}`,
    };
  }
  const executablePath = path.resolve(dir, manifest.executable);
  if (executablePath !== dir && !executablePath.startsWith(dir + path.sep)) {
    return { available: false, reason: `verifier browser executable escapes its payload dir: ${manifest.executable}` };
  }
  let actual: string;
  try {
    actual = sha256File(executablePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { available: false, reason: `verifier browser binary unreadable at ${executablePath}: ${detail}` };
  }
  if (actual !== manifest.sha256) {
    return {
      available: false,
      reason: `verifier browser binary hash mismatch: manifest ${manifest.sha256}, on disk ${actual}`,
    };
  }
  return {
    executablePath,
    version: manifest.version,
    sha256: manifest.sha256,
    platform: manifest.platform,
    arch: manifest.arch,
  };
}

function parseManifest(text: string): BrowserManifest {
  const raw: unknown = JSON.parse(text);
  if (raw === null || typeof raw !== "object") throw new Error("manifest is not an object");
  const record = raw as Record<string, unknown>;
  for (const key of ["version", "platform", "arch", "executable", "sha256"] as const) {
    if (typeof record[key] !== "string" || record[key] === "") {
      throw new Error(`manifest field ${key} missing`);
    }
  }
  return record as unknown as BrowserManifest;
}

/** Streams the file through SHA-256 in fixed chunks; never holds the binary in memory. */
export function sha256File(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK);
    let read = fs.readSync(fd, chunk, 0, HASH_CHUNK, null);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(fd, chunk, 0, HASH_CHUNK, null);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
