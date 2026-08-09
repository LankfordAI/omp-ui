import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROVIDER_ENV_NAMES, PROVIDER_KEY_SPECS } from "./provider-catalog";
import type { ProviderKeyStatus, ProviderKeySource } from "./types";

/**
 * Provider credentials omp-ui supplies to every omp it launches.
 *
 * The problem this solves: omp authenticates from environment variables, and a
 * GUI launched from a .desktop entry, an AppImage, or a dock icon inherits the
 * session-manager environment — never `~/.zshrc`. omp then sees no keys and its
 * catalog collapses to whatever needs none (issue: only the local `vllm`
 * provider appeared in the model picker, because `OPENROUTER_API_KEY` was
 * exported in the user's shell rc and nowhere the GUI could see it).
 *
 * Three sources are consulted, highest priority first:
 *
 * 1. **stored** — typed into the providers settings page, encrypted at rest by
 *    the injected {@link KeyCipher} (Electron's safeStorage in the app). An
 *    explicit in-app value outranks the ambient environment: otherwise typing a
 *    key would silently do nothing whenever a stale variable was inherited.
 * 2. **environment** — genuinely inherited, i.e. omp-ui was launched from a
 *    terminal that had the key. Snapshotted at construction, before the first
 *    apply, so it stays reportable after stored values are installed.
 * 3. **login-shell** — captured by asking the user's own login shell to print
 *    the variables it exports. This is what repairs the .desktop launch with no
 *    user action at all.
 *
 * Resolved values are installed into this process's own `process.env` rather
 * than threaded through each spawn site, because every launch path already
 * spreads `process.env`: the rpc client, the PTY, the title/branch model runs,
 * and the console-drawer shell all inherit the fix from one place, and none of
 * their signatures change.
 *
 * Project `.env` / `.env.local` files are read for **reporting only**. omp
 * loads those itself (verified against v17.1.8: a key in the project `.env`
 * yields the full catalog), so injecting them here would duplicate omp's own
 * loader and its precedence rules. The providers page still surfaces them so a
 * key that is already working is never labelled "not set".
 */

/** Encrypts stored key material. Electron's safeStorage in the desktop app. */
export interface KeyCipher {
  /** False when the platform offers no encryption; writes are then refused. */
  readonly available: boolean;
  /** Backend label for display (e.g. `gnome_libsecret`, `basic_text`). */
  readonly backend: string;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** On-disk shape. Values are base64 of the cipher's blob, never plaintext. */
interface KeyFile {
  schemaVersion: 1;
  /** Keyed by environment variable name. */
  keys: Record<string, string>;
}

/** Longest credential accepted — well past any real token, short of a paste accident. */
const MAX_KEY_BYTES = 8192;

/** How long the login shell gets to print its exports before we give up. */
const SHELL_CAPTURE_TIMEOUT_MS = 5_000;

/** The dotenv files omp itself loads from a project, in omp's own order. */
const DOTENV_FILES = [".env", ".env.local"] as const;

/**
 * Rejects anything that cannot be an API credential. Surrounding whitespace is
 * a normal paste artifact and is trimmed, but *interior* whitespace is not:
 * every credential in the catalog is an opaque token with none, so a value
 * containing any is a mis-paste — a whole `export NAME=value` line, a shell
 * snippet, a PEM — and is refused with a message instead of being stored as a
 * credential that could never work.
 */
function validateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("key is empty");
  if (trimmed.includes("\0")) throw new Error("key must not contain null bytes");
  if (/\s/.test(trimmed)) {
    throw new Error("key must be a single token — paste only the key itself, not a whole line");
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_KEY_BYTES) {
    throw new Error(`key is longer than ${MAX_KEY_BYTES} bytes`);
  }
  return trimmed;
}

/** Only variables this feature knows about may be written or injected. */
function knownEnvName(name: string): boolean {
  return PROVIDER_ENV_NAMES.includes(name);
}

/**
 * Last four characters behind a fixed-width mask. The renderer never receives
 * key material, so this is all a status row can show; a value too short to
 * mask meaningfully shows none of itself.
 */
export function maskKey(value: string): string {
  const tail = value.length >= 12 ? value.slice(-4) : "";
  return tail === "" ? "••••" : `••••${tail}`;
}

/** Minimal `KEY=value` reader for the report-only dotenv scan. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export[ \t]+/, "").trim();
    if (!knownEnvName(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    if (value !== "") out[name] = value;
  }
  return out;
}

/** Provider variables set by a project's dotenv files. Never throws. */
export function readDotenvKeys(projectCwd: string | null): Record<string, string> {
  if (projectCwd === null) return {};
  const found: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    try {
      Object.assign(found, parseDotenv(fs.readFileSync(path.join(projectCwd, name), "utf8")));
    } catch {
      // Absent or unreadable: this scan is a courtesy, not a requirement.
    }
  }
  return found;
}

export type ShellCaptureFn = (script: string, shell: string) => Promise<string>;

function defaultShellCapture(script: string, shell: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      // `-i` matters: interactive is the only mode that sources ~/.zshrc or the
      // interactive half of ~/.bashrc, which is where users actually export
      // keys. `-l` adds the profile files. Verified: `-lc` alone sees nothing.
      child = spawn(shell, ["-ilc", script], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), SHELL_CAPTURE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/**
 * Asks the user's login shell to print the provider variables it exports.
 *
 * Only the known names are requested, one `NAME=value` line each, rather than
 * dumping the whole environment: it keeps the parse unambiguous and means an
 * unrelated variable holding a secret is never read at all. Best-effort — a
 * missing shell, an rc file that hangs, or a non-zero exit all yield `{}`.
 */
export async function captureLoginShellKeys(
  opts: { shell?: string; platform?: string; capture?: ShellCaptureFn } = {},
): Promise<Record<string, string>> {
  const platform = opts.platform ?? process.platform;
  // No login-shell rc convention on Windows; cmd.exe would just fail the flags.
  if (platform === "win32") return {};
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
  const script = PROVIDER_ENV_NAMES.map(
    (name) => `printf '%s=%s\\n' ${name} "$${name}"`,
  ).join("; ");
  const raw = await (opts.capture ?? defaultShellCapture)(script, shell);
  const found: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (value !== "" && knownEnvName(name)) found[name] = value;
  }
  return found;
}

export function credentialStoreUnavailableMessage(
  platform: NodeJS.Platform = process.platform,
): string {
  const alternative =
    platform === "win32"
      ? "set it in Settings → Providers or as a Windows user environment variable"
      : "export the variable from your shell instead";
  return `no OS credential store is available, so a key cannot be saved securely — ${alternative}`;
}

/**
 * The credential set omp-ui hands to omp, plus the reporting the providers page
 * renders. One instance per app, owned by MainBackend.
 */
export class ProviderKeys {
  /** Plaintext keys, keyed by env name. Never leaves the main process. */
  private stored = new Map<string, string>();
  private shellKeys: Record<string, string> = {};
  private shellCaptured = false;
  /** The environment as inherited, captured before any value is installed. */
  private readonly baseEnv: Record<string, string>;

  constructor(
    private readonly file: string,
    private readonly cipher: KeyCipher,
    /**
     * The environment this instance reads its baseline from AND installs into.
     * One reference, so a capture that happens later cannot apply somewhere
     * other than where the baseline came from.
     */
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    const snapshot: Record<string, string> = {};
    for (const name of PROVIDER_ENV_NAMES) {
      const value = env[name]?.trim();
      if (value) snapshot[name] = value;
    }
    this.baseEnv = snapshot;
    this.load();
  }

  get backend(): string {
    return this.cipher.backend;
  }

  get encryptionAvailable(): boolean {
    return this.cipher.available;
  }

  /**
   * A key file written by a working keyring cannot be decrypted after the
   * keyring changes, and an undecryptable entry is indistinguishable from a
   * corrupt one — both are dropped rather than taking the app down, and the
   * page simply reports the key as unset so the user can retype it.
   */
  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object" || !("keys" in parsed)) return;
    const keys = (parsed as KeyFile).keys;
    if (keys === null || typeof keys !== "object") return;
    for (const [name, blob] of Object.entries(keys)) {
      if (!knownEnvName(name) || typeof blob !== "string") continue;
      try {
        const value = this.cipher.decrypt(Buffer.from(blob, "base64")).trim();
        if (value !== "") this.stored.set(name, value);
      } catch {
        // Wrong keyring, rotated master key, or a truncated file.
      }
    }
  }

  /** 0600 — the file holds credentials even when the cipher is only obfuscation. */
  private save(): void {
    const keys: Record<string, string> = {};
    for (const [name, value] of this.stored) {
      keys[name] = this.cipher.encrypt(value).toString("base64");
    }
    const data: KeyFile = { schemaVersion: 1, keys };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  /**
   * Installs the resolved credentials into this process's environment, where
   * every omp launch path already inherits them. Stored beats inherited beats
   * login-shell; a name with no value anywhere is left exactly as it was, so
   * this never blanks a variable some other layer is providing.
   */
  applyToProcessEnv(env: NodeJS.ProcessEnv = this.env): void {
    for (const name of PROVIDER_ENV_NAMES) {
      const value = this.stored.get(name) ?? this.baseEnv[name] ?? this.shellKeys[name];
      if (value !== undefined) env[name] = value;
    }
  }

  /**
   * One-shot login-shell capture, then re-apply. Awaited at boot before the
   * first session can spawn; repeated calls are no-ops so a refresh from the
   * settings page cannot pile up shell processes.
   */
  async captureLoginShell(opts?: { capture?: ShellCaptureFn }): Promise<void> {
    if (this.shellCaptured) return;
    this.shellCaptured = true;
    this.shellKeys = await captureLoginShellKeys({ ...opts, platform: this.platform });
    this.applyToProcessEnv();
  }

  /** Stores one credential and installs it immediately. Rejects unknown names. */
  setKey(envName: string, value: string): void {
    if (!knownEnvName(envName)) throw new Error(`unknown provider variable: ${envName}`);
    if (!this.cipher.available) {
      throw new Error(credentialStoreUnavailableMessage(this.platform));
    }
    this.stored.set(envName, validateKey(value));
    this.save();
    this.applyToProcessEnv();
  }

  /**
   * Forgets a stored credential. The variable falls back to whatever the
   * environment or login shell supplies; when nothing does, it is removed from
   * this process outright so the next omp genuinely sees it unset.
   */
  clearKey(envName: string, env: NodeJS.ProcessEnv = this.env): void {
    if (!knownEnvName(envName)) throw new Error(`unknown provider variable: ${envName}`);
    if (!this.stored.delete(envName)) return;
    this.save();
    const fallback = this.baseEnv[envName] ?? this.shellKeys[envName];
    if (fallback === undefined) delete env[envName];
    else env[envName] = fallback;
  }

  /** Where a variable's effective value comes from, in injection order. */
  private sourceOf(envName: string, dotenv: Record<string, string>): ProviderKeySource {
    if (this.stored.has(envName)) return "stored";
    if (this.baseEnv[envName] !== undefined) return "environment";
    if (this.shellKeys[envName] !== undefined) return "login-shell";
    if (dotenv[envName] !== undefined) return "dotenv";
    return "none";
  }

  private valueOf(envName: string, dotenv: Record<string, string>): string | undefined {
    return (
      this.stored.get(envName) ??
      this.baseEnv[envName] ??
      this.shellKeys[envName] ??
      dotenv[envName]
    );
  }

  /**
   * One row per catalogued provider for the settings page. Key material is
   * masked here, at the process boundary — the renderer never sees a full
   * credential, only its tail.
   */
  statuses(projectCwd: string | null): ProviderKeyStatus[] {
    const dotenv = readDotenvKeys(projectCwd);
    return PROVIDER_KEY_SPECS.map((spec) => {
      const names = [spec.env, ...(spec.alsoRead ?? [])];
      // The primary variable decides the row; an alternate only counts when the
      // primary is unset, mirroring how omp falls back between them.
      const active = names.find((name) => this.sourceOf(name, dotenv) !== "none") ?? spec.env;
      const value = this.valueOf(active, dotenv);
      return {
        id: spec.id,
        label: spec.label,
        group: spec.group,
        env: spec.env,
        activeEnv: active,
        source: this.sourceOf(active, dotenv),
        masked: value === undefined ? null : maskKey(value),
        hint: spec.hint ?? null,
        /**
         * A stored value shadows the ambient one; the page says so rather than
         * leaving the user to wonder why their shell export stopped mattering.
         */
        shadowsEnvironment:
          this.stored.has(active) &&
          (this.baseEnv[active] !== undefined || this.shellKeys[active] !== undefined),
      };
    });
  }
}
