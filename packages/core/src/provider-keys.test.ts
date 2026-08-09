import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLoginShellKeys,
  credentialStoreUnavailableMessage,
  maskKey,
  ProviderKeys,
  readDotenvKeys,
  type KeyCipher,
} from "./provider-keys";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-keys-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Reversible stand-in for safeStorage: the tests care that plaintext never
 * reaches disk and that a round trip restores the value, not about the cipher.
 */
function fakeCipher(overrides: Partial<KeyCipher> = {}): KeyCipher {
  return {
    available: true,
    backend: "test",
    encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decrypt: (blob) => {
      const text = blob.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not our ciphertext");
      return text.slice(4);
    },
    ...overrides,
  };
}

const KEY = "OPENROUTER_API_KEY";
const LONG = "sk-or-v1-0123456789abcdef";

function make(
  opts: { env?: NodeJS.ProcessEnv; cipher?: KeyCipher; file?: string; platform?: NodeJS.Platform } = {},
): { keys: ProviderKeys; file: string } {
  const file = opts.file ?? path.join(tmpDir(), "provider-keys.json");
  return {
    keys: new ProviderKeys(file, opts.cipher ?? fakeCipher(), opts.env ?? {}, opts.platform),
    file,
  };
}

function row(keys: ProviderKeys, id: string, projectCwd: string | null = null) {
  const found = keys.statuses(projectCwd).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no such provider row: ${id}`);
  return found;
}

describe("maskKey", () => {
  it("reveals only the last four characters", () => {
    expect(maskKey("sk-or-v1-abcdefgh")).toBe("••••efgh");
  });

  it("reveals nothing from a value too short to mask safely", () => {
    expect(maskKey("sk-abc")).toBe("••••");
  });
});

describe("ProviderKeys storage", () => {
  it("injects a stored key into the environment omp inherits", () => {
    const env: NodeJS.ProcessEnv = {};
    const { keys } = make();
    keys.setKey(KEY, LONG);
    keys.applyToProcessEnv(env);
    expect(env[KEY]).toBe(LONG);
  });

  it("never writes plaintext to disk", () => {
    const { keys, file } = make();
    keys.setKey(KEY, LONG);
    expect(fs.readFileSync(file, "utf8")).not.toContain(LONG);
  });

  it.runIf(process.platform !== "win32")("writes the key file 0600 — it holds credentials", () => {
    const { keys, file } = make();
    keys.setKey(KEY, LONG);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("round-trips a stored key across a restart", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    make({ file }).keys.setKey(KEY, LONG);
    expect(row(new ProviderKeys(file, fakeCipher(), {}), "openrouter")).toMatchObject({
      source: "stored",
      masked: "••••cdef",
    });
  });

  it("drops an entry the cipher can no longer decrypt instead of failing to load", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    make({ file }).keys.setKey(KEY, LONG);
    // A rotated keyring or a different machine: the blob is intact but foreign.
    const hostile = fakeCipher({
      decrypt: () => {
        throw new Error("wrong keyring");
      },
    });
    expect(row(new ProviderKeys(file, hostile, {}), "openrouter").source).toBe("none");
  });

  it("ignores a corrupt key file rather than taking the app down", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    fs.writeFileSync(file, "{ not json");
    expect(row(new ProviderKeys(file, fakeCipher(), {}), "openrouter").source).toBe("none");
  });

  it("refuses a variable it does not know, so arbitrary env injection is impossible", () => {
    const { keys } = make();
    expect(() => keys.setKey("LD_PRELOAD", "/tmp/evil.so")).toThrow(/unknown provider variable/);
  });

  it("refuses a multi-line paste (a whole export line, a PEM) with a usable message", () => {
    const { keys } = make();
    expect(() => keys.setKey(KEY, "export OPENROUTER_API_KEY=x\n")).toThrow(/single token/);
    expect(() => keys.setKey(KEY, "-----BEGIN KEY-----\nabc\n-----END KEY-----")).toThrow(
      /single token/,
    );
  });

  it("trims a paste's surrounding whitespace, which is a normal artifact", () => {
    const env: NodeJS.ProcessEnv = {};
    const { keys } = make({ env });
    keys.setKey(KEY, `  ${LONG}\n`);
    expect(env[KEY]).toBe(LONG);
  });

  it("refuses an empty value", () => {
    const { keys } = make();
    expect(() => keys.setKey(KEY, "   ")).toThrow(/empty/);
  });

  it("refuses to save when no credential store is available", () => {
    const { keys } = make({ cipher: fakeCipher({ available: false }) });
    expect(() => keys.setKey(KEY, LONG)).toThrow(/no OS credential store/);
  });
});

  it("gives Windows-specific secure-storage guidance", () => {
    expect(credentialStoreUnavailableMessage("win32")).toContain(
      "Settings → Providers or as a Windows user environment variable",
    );
    expect(credentialStoreUnavailableMessage("linux")).toContain("export the variable from your shell");
  });

  it("reconstructs and injects a stored Windows credential", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    const cipher = fakeCipher({ backend: "windows-dpapi" });
    new ProviderKeys(file, cipher, {}, "win32").setKey(KEY, LONG);
    const env: NodeJS.ProcessEnv = {};
    const reconstructed = new ProviderKeys(file, cipher, env, "win32");
    reconstructed.applyToProcessEnv();
    expect(env[KEY]).toBe(LONG);
    expect(reconstructed.backend).toBe("windows-dpapi");
    expect(row(reconstructed, "openrouter").source).toBe("stored");
  });

describe("ProviderKeys precedence", () => {
  it("prefers a stored key over an inherited one, and says it is shadowing", () => {
    const env: NodeJS.ProcessEnv = { [KEY]: "sk-or-inherited-value" };
    const { keys } = make({ env });
    keys.setKey(KEY, LONG);
    keys.applyToProcessEnv(env);
    expect(env[KEY]).toBe(LONG);
    expect(row(keys, "openrouter")).toMatchObject({ source: "stored", shadowsEnvironment: true });
  });

  it("reports an inherited key as environment and leaves it alone", () => {
    const env: NodeJS.ProcessEnv = { [KEY]: LONG };
    const { keys } = make({ env });
    keys.applyToProcessEnv(env);
    expect(env[KEY]).toBe(LONG);
    expect(row(keys, "openrouter")).toMatchObject({
      source: "environment",
      shadowsEnvironment: false,
    });
  });

  it("restores the inherited value when a stored key is cleared", () => {
    const inherited = "sk-or-inherited-value";
    const env: NodeJS.ProcessEnv = { [KEY]: inherited };
    const { keys } = make({ env });
    keys.setKey(KEY, LONG);
    keys.clearKey(KEY, env);
    expect(env[KEY]).toBe(inherited);
    expect(row(keys, "openrouter").source).toBe("environment");
  });

  it("unsets the variable outright when nothing else supplies it", () => {
    const env: NodeJS.ProcessEnv = {};
    const { keys } = make({ env });
    keys.setKey(KEY, LONG);
    keys.applyToProcessEnv(env);
    keys.clearKey(KEY, env);
    expect(KEY in env).toBe(false);
  });

  it("leaves an untouched variable exactly as it was", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", OPENAI_API_KEY: "sk-openai-untouched" };
    const { keys } = make({ env });
    keys.applyToProcessEnv(env);
    expect(env).toEqual({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-openai-untouched" });
  });

  it("falls back to an alternate variable when the primary is unset", () => {
    // omp documents ANTHROPIC_OAUTH_TOKEN as outranking the API key; a row must
    // report the one actually supplying auth, not "not set".
    const { keys } = make({ env: { ANTHROPIC_OAUTH_TOKEN: "oauth-token-value-1234" } });
    expect(row(keys, "anthropic")).toMatchObject({
      env: "ANTHROPIC_API_KEY",
      activeEnv: "ANTHROPIC_OAUTH_TOKEN",
      source: "environment",
    });
  });

  it("reports nothing configured as none, with no masked tail to leak", () => {
    expect(row(make().keys, "openrouter")).toMatchObject({ source: "none", masked: null });
  });
});

describe("ProviderKeys login-shell capture", () => {
  it("adopts a key the shell profile exports but the GUI never inherited", async () => {
    const env: NodeJS.ProcessEnv = {};
    const { keys } = make({ env, platform: "linux" });
    await keys.captureLoginShell({ capture: async () => `${KEY}=${LONG}\n` });
    expect(env[KEY]).toBe(LONG);
    expect(row(keys, "openrouter").source).toBe("login-shell");
  });

  it("runs the shell once, so repeated refreshes cannot pile up processes", async () => {
    let calls = 0;
    const { keys } = make({ platform: "linux" });
    const capture = async (): Promise<string> => {
      calls += 1;
      return "";
    };
    await keys.captureLoginShell({ capture });
    await keys.captureLoginShell({ capture });
    expect(calls).toBe(1);
  });

  it("survives a shell that prints nothing usable", async () => {
    const { keys } = make({ platform: "linux" });
    await keys.captureLoginShell({ capture: async () => "zsh: command not found: printf\n" });
    expect(row(keys, "openrouter").source).toBe("none");
  });
});

describe("captureLoginShellKeys", () => {
  it("asks only for the known variables and keeps the ones with values", async () => {
    let script = "";
    const found = await captureLoginShellKeys({
      platform: "linux",
      shell: "/bin/zsh",
      capture: async (s) => {
        script = s;
        return `${KEY}=${LONG}\nOPENAI_API_KEY=\nUNRELATED_SECRET=nope\n`;
      },
    });
    expect(found).toEqual({ [KEY]: LONG });
    // Only the catalogued names are ever requested — an unrelated variable
    // holding a secret is not read at all.
    expect(script).toContain(KEY);
    expect(script).not.toContain("UNRELATED_SECRET");
  });

  it("skips the capture entirely on Windows, which has no rc convention", async () => {
    let ran = false;
    const found = await captureLoginShellKeys({
      platform: "win32",
      capture: async () => {
        ran = true;
        return `${KEY}=${LONG}`;
      },
    });
    expect(found).toEqual({});
    expect(ran).toBe(false);
  });
});

describe("readDotenvKeys", () => {
  it("reports a project .env key omp will load itself", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${LONG}\n`);
    expect(readDotenvKeys(dir)).toEqual({ [KEY]: LONG });
  });

  it("honours .env.local over .env, matching omp's own order", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), `${KEY}=from-env\n`);
    fs.writeFileSync(path.join(dir, ".env.local"), `${KEY}=from-env-local\n`);
    expect(readDotenvKeys(dir)[KEY]).toBe("from-env-local");
  });

  it("accepts export prefixes, quotes, and skips comments", () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, ".env"),
      ["# a comment", `export ${KEY}="${LONG}"`, "GARBAGE", ""].join("\n"),
    );
    expect(readDotenvKeys(dir)).toEqual({ [KEY]: LONG });
  });

  it("ignores variables outside the provider catalog", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://localhost/app\n");
    expect(readDotenvKeys(dir)).toEqual({});
  });

  it("is a no-op with no project and never throws on a missing file", () => {
    expect(readDotenvKeys(null)).toEqual({});
    expect(readDotenvKeys(path.join(tmpDir(), "nope"))).toEqual({});
  });

  it("reports a dotenv key as dotenv but does NOT inject it — omp loads it", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${LONG}\n`);
    const env: NodeJS.ProcessEnv = {};
    const { keys } = make({ env });
    keys.applyToProcessEnv(env);
    expect(KEY in env).toBe(false);
    expect(row(keys, "openrouter", dir)).toMatchObject({ source: "dotenv", masked: "••••cdef" });
  });
});
