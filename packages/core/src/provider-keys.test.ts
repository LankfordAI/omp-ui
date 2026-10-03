import nodeFs, * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** Writes the on-disk shape load() reads, so tests can seed entries directly. */
function writeKeyFile(file: string, keys: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, keys }, null, 2)}\n`);
}

/** The `keys` map from disk, for asserting untouched blobs survive byte-for-byte. */
function keyEntries(file: string): Record<string, string> {
  const parsed: { keys: Record<string, string> } = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.keys;
}

/** Ciphertext fakeCipher refuses — the signature of a rotated or foreign keyring. */
const FOREIGN = Buffer.from("foreign-keyring", "utf8").toString("base64");

/** Well-formed ciphertext that decrypts to an empty value. */
const EMPTY_CIPHER = Buffer.from("enc: \n\t", "utf8").toString("base64");

/** Ciphertext the default fakeCipher round-trips back to `value`. */
function readable(value: string): string {
  return Buffer.from(`enc:${value}`, "utf8").toString("base64");
}

/** Fail one real filesystem step, then restore both default and ESM bindings. */
function withSaveFailureOnce<T>(step: "write" | "rename", run: () => T): T {
  const fail = (): never => {
    throw new Error(`simulated ${step} failure`);
  };
  const spy = step === "write"
    ? vi.spyOn(nodeFs, "writeFileSync").mockImplementationOnce(fail)
    : vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(fail);
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

/** A keyring that refuses fakeCipher's blobs and writes its own. */
function rotatedCipher(): KeyCipher {
  return {
    available: true,
    backend: "test-rotated",
    encrypt: (plain) => Buffer.from(`rot:${plain}`, "utf8"),
    decrypt: (blob) => {
      const text = blob.toString("utf8");
      if (!text.startsWith("rot:")) throw new Error("wrong keyring");
      return text.slice(4);
    },
  };
}

/** Reads fakeCipher's ciphertext but writes different bytes, exposing re-encryption. */
function rewritingCipher(): KeyCipher {
  return fakeCipher({
    encrypt: (plain) => Buffer.from(`ren:${plain}`, "utf8"),
    decrypt: (blob) => {
      const text = blob.toString("utf8");
      if (text.startsWith("enc:") || text.startsWith("ren:")) return text.slice(4);
      throw new Error("not our ciphertext");
    },
  });
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

describe("ProviderKeys unreadable stored entries", () => {
  it.each(["throws", "decrypts to blank"] as const)(
    "when the cipher %s, warns about the entry instead of pretending it is gone",
    (mode) => {
      const file = path.join(tmpDir(), "provider-keys.json");
      // A rotated keyring refuses the blob outright; a stale one yields nothing.
      writeKeyFile(file, { [KEY]: mode === "throws" ? FOREIGN : EMPTY_CIPHER });
      const before = fs.readFileSync(file, "utf8");
      const env: NodeJS.ProcessEnv = {};
      const keys = new ProviderKeys(file, fakeCipher(), env);
      const entry = row(keys, "openrouter");
      expect(entry).toMatchObject({ source: "none", masked: null, shadowsEnvironment: false });
      expect(entry.unreadableStoredEnvs).toEqual([KEY]);
      expect(keys.hasModelProvider(null)).toBe(false);
      keys.applyToProcessEnv(env);
      expect(env).toEqual({});
      // Reporting never rewrites: a later restart with the right store still works.
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    },
  );

  it("becomes readable again when a restart finds the original keyring", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    new ProviderKeys(file, rotatedCipher(), {}).setKey(KEY, LONG);
    const stuck = new ProviderKeys(file, fakeCipher(), {});
    expect(row(stuck, "openrouter")).toMatchObject({ source: "none", masked: null });
    expect(row(stuck, "openrouter").unreadableStoredEnvs).toEqual([KEY]);
    const env: NodeJS.ProcessEnv = {};
    const restored = new ProviderKeys(file, rotatedCipher(), env);
    expect(row(restored, "openrouter")).toMatchObject({ source: "stored", masked: "••••cdef" });
    expect(row(restored, "openrouter").unreadableStoredEnvs).toEqual([]);
    restored.applyToProcessEnv(env);
    expect(env[KEY]).toBe(LONG);
  });

  it("preserves every untouched blob across unrelated edits and a compatible restart", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    const openai = "sk-openai-0123456789";
    const xai = "synthetic-xai-original-1234";
    const originalEntries = {
      [KEY]: rotatedCipher().encrypt(LONG).toString("base64"),
      XAI_API_KEY: rotatedCipher().encrypt(xai).toString("base64"),
      OPENAI_API_KEY: readable(openai),
    };
    writeKeyFile(file, originalEntries);
    // Re-encrypting the readable sibling would change its original bytes too.
    const keys = new ProviderKeys(file, rewritingCipher(), {});
    keys.setKey("GROQ_API_KEY", LONG);
    const afterSet = keyEntries(file);
    for (const [name, blob] of Object.entries(originalEntries)) {
      expect(afterSet[name]).toBe(blob);
    }
    keys.clearKey("GROQ_API_KEY");
    expect(keyEntries(file)).toEqual(originalEntries);
    expect(row(keys, "openai")).toMatchObject({ source: "stored", masked: "••••6789" });
    expect(row(keys, "openrouter").unreadableStoredEnvs).toEqual([KEY]);
    const env: NodeJS.ProcessEnv = {};
    const compatible = fakeCipher({
      decrypt: (blob) => blob.toString().startsWith("rot:")
        ? rotatedCipher().decrypt(blob)
        : fakeCipher().decrypt(blob),
    });
    const restarted = new ProviderKeys(file, compatible, env);
    restarted.applyToProcessEnv();
    expect(env).toEqual({ [KEY]: LONG, XAI_API_KEY: xai, OPENAI_API_KEY: openai });
    expect(row(restarted, "openrouter")).toMatchObject({
      source: "stored", masked: "••••cdef", unreadableStoredEnvs: [],
    });
    expect(row(restarted, "xai")).toMatchObject({
      source: "stored", masked: "••••1234", unreadableStoredEnvs: [],
    });
  });

  it("replaces only the target's blob when overwriting an unreadable entry", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, { [KEY]: FOREIGN, OPENAI_API_KEY: FOREIGN, XAI_API_KEY: EMPTY_CIPHER });
    const keys = new ProviderKeys(file, rewritingCipher(), {});
    keys.setKey(KEY, LONG);
    const entries = keyEntries(file);
    expect(entries[KEY]).toBe(Buffer.from(`ren:${LONG}`, "utf8").toString("base64"));
    expect(entries.OPENAI_API_KEY).toBe(FOREIGN);
    expect(entries.XAI_API_KEY).toBe(EMPTY_CIPHER);
    const entry = row(keys, "openrouter");
    expect(entry).toMatchObject({ source: "stored", masked: "••••cdef" });
    expect(entry.unreadableStoredEnvs).toEqual([]);
    expect(row(keys, "openai").unreadableStoredEnvs).toEqual(["OPENAI_API_KEY"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("clears an unreadable entry with no credential store, keeping the ambient value", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, { [KEY]: FOREIGN, OPENAI_API_KEY: FOREIGN });
    const ambient = "sk-or-inherited-value";
    const env: NodeJS.ProcessEnv = { [KEY]: ambient };
    const keys = new ProviderKeys(file, fakeCipher({ available: false }), env);
    expect(row(keys, "openrouter")).toMatchObject({ source: "environment", masked: "••••alue" });
    expect(() => keys.setKey(KEY, LONG)).toThrow(/no OS credential store/);
    keys.clearKey(KEY, env);
    expect(env[KEY]).toBe(ambient);
    expect(keyEntries(file)).toEqual({ OPENAI_API_KEY: FOREIGN });
    expect(row(keys, "openrouter").unreadableStoredEnvs).toEqual([]);
    expect(row(keys, "openai").unreadableStoredEnvs).toEqual(["OPENAI_API_KEY"]);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves the file byte-identical when clearing a name it never stored", () => {
    const { keys, file } = make();
    keys.setKey(KEY, LONG);
    const before = fs.readFileSync(file, "utf8");
    keys.clearKey("GROQ_API_KEY");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports a usable alternate while warning that the saved primary is unreadable", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, {
      ANTHROPIC_API_KEY: FOREIGN,
      ANTHROPIC_OAUTH_TOKEN: readable("oauth-token-value-1234"),
    });
    const keys = new ProviderKeys(file, fakeCipher(), {});
    const entry = row(keys, "anthropic");
    expect(entry).toMatchObject({
      env: "ANTHROPIC_API_KEY",
      activeEnv: "ANTHROPIC_OAUTH_TOKEN",
      source: "stored",
      masked: "••••1234",
    });
    expect(entry.unreadableStoredEnvs).toEqual(["ANTHROPIC_API_KEY"]);
    expect(keys.hasModelProvider(null)).toBe(true);
  });

  it("reports the readable primary and lists only the unreadable alternates", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, {
      ANTHROPIC_API_KEY: readable("sk-ant-0123456789abcd"),
      ANTHROPIC_OAUTH_TOKEN: FOREIGN,
      ANTHROPIC_AUTH_TOKEN: EMPTY_CIPHER,
    });
    const keys = new ProviderKeys(file, fakeCipher(), {});
    const entry = row(keys, "anthropic");
    expect(entry).toMatchObject({
      activeEnv: "ANTHROPIC_API_KEY",
      source: "stored",
      masked: "••••abcd",
    });
    expect(entry.unreadableStoredEnvs).toEqual(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);
  });

  it("lists every unreadable variable in catalog order regardless of file order", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, {
      ANTHROPIC_AUTH_TOKEN: FOREIGN,
      ANTHROPIC_OAUTH_TOKEN: EMPTY_CIPHER,
      ANTHROPIC_API_KEY: FOREIGN,
    });
    const keys = new ProviderKeys(file, fakeCipher(), {});
    const entry = row(keys, "anthropic");
    expect(entry).toMatchObject({ activeEnv: "ANTHROPIC_API_KEY", source: "none", masked: null });
    expect(entry.unreadableStoredEnvs).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });
});

describe("ProviderKeys unreadable entries with a working fallback", () => {
  it.each([
    ["environment", "sk-or-inherited-value", true],
    ["login-shell", "sk-shell-0123456789", true],
    ["dotenv", "sk-dotenv-0123456789", false],
  ] as const)(
    "keeps the warning while reporting the %s value it actually injects",
    async (kind, value, injected) => {
      const file = path.join(tmpDir(), "provider-keys.json");
      writeKeyFile(file, { [KEY]: FOREIGN });
      const projectCwd = kind === "dotenv" ? tmpDir() : null;
      if (projectCwd !== null) {
        fs.writeFileSync(path.join(projectCwd, ".env"), `${KEY}=${value}\n`);
      }
      const env: NodeJS.ProcessEnv = kind === "environment" ? { [KEY]: value } : {};
      const keys = new ProviderKeys(file, fakeCipher(), env, "linux");
      if (kind === "login-shell") {
        await keys.captureLoginShell({ capture: async () => `${KEY}=${value}\n` });
      } else {
        keys.applyToProcessEnv(env);
      }
      const entry = row(keys, "openrouter", projectCwd);
      expect(entry).toMatchObject({ activeEnv: KEY, source: kind, masked: maskKey(value) });
      expect(entry.unreadableStoredEnvs).toEqual([KEY]);
      expect(keys.hasModelProvider(projectCwd)).toBe(true);
      // dotenv stays report-only — omp loads the project file itself.
      if (injected) expect(env[KEY]).toBe(value);
      else expect(KEY in env).toBe(false);
    },
  );
});

describe("ProviderKeys failed mutations leave nothing behind", () => {
  it("keeps everything as it was when encryption fails during a set", () => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, { [KEY]: FOREIGN, OPENAI_API_KEY: readable(LONG) });
    const before = fs.readFileSync(file, "utf8");
    const env: NodeJS.ProcessEnv = { [KEY]: "synthetic-ambient-1234" };
    const keys = new ProviderKeys(
      file,
      fakeCipher({
        encrypt: () => {
          throw new Error("keyring locked");
        },
      }),
      env,
    );
    keys.applyToProcessEnv();
    const beforeStatus = keys.statuses(null);
    const beforeEnv = { ...env };
    expect(() => keys.setKey(KEY, LONG)).toThrow(/keyring locked/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["provider-keys.json"]);
    expect(keys.statuses(null)).toEqual(beforeStatus);
    expect(env).toEqual(beforeEnv);
  });

  it.each([
    ["saves", "write"],
    ["commits", "rename"],
  ] as const)("keeps the old file and state when a set %s fails", (label, step) => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, { [KEY]: FOREIGN, OPENAI_API_KEY: readable(LONG) });
    const env: NodeJS.ProcessEnv = { [KEY]: "synthetic-ambient-1234" };
    const before = fs.readFileSync(file, "utf8");
    const keys = new ProviderKeys(file, fakeCipher(), env);
    keys.applyToProcessEnv();
    const beforeStatus = keys.statuses(null);
    const beforeEnv = { ...env };
    expect(() =>
      withSaveFailureOnce(step, () => keys.setKey(KEY, "sk-or-v1-replacement-99")),
    ).toThrow(new RegExp(`simulated ${step} failure`));
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["provider-keys.json"]);
    expect(keys.statuses(null)).toEqual(beforeStatus);
    expect(env).toEqual(beforeEnv);
  });

  it.each([
    ["saves", "write"],
    ["commits", "rename"],
  ] as const)("keeps the old file and the entry when a clear %s fails", (label, step) => {
    const file = path.join(tmpDir(), "provider-keys.json");
    writeKeyFile(file, { [KEY]: FOREIGN, OPENAI_API_KEY: readable("sk-openai-0123456789") });
    const before = fs.readFileSync(file, "utf8");
    const env: NodeJS.ProcessEnv = { [KEY]: "synthetic-ambient-1234" };
    const keys = new ProviderKeys(file, fakeCipher(), env);
    keys.applyToProcessEnv();
    const beforeStatus = keys.statuses(null);
    const beforeEnv = { ...env };
    expect(() => withSaveFailureOnce(step, () => keys.clearKey(KEY, env))).toThrow(
      new RegExp(`simulated ${step} failure`),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["provider-keys.json"]);
    expect(keys.statuses(null)).toEqual(beforeStatus);
    expect(env).toEqual(beforeEnv);
  });
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

describe("hasModelProvider", () => {
  it("is false with no credential anywhere", () => {
    expect(make().keys.hasModelProvider(null)).toBe(false);
  });

  it("is true with a stored model key", () => {
    const { keys } = make();
    keys.setKey(KEY, LONG);
    expect(keys.hasModelProvider(null)).toBe(true);
  });

  it("is true with an inherited model key", () => {
    const { keys } = make({ env: { [KEY]: LONG } });
    expect(keys.hasModelProvider(null)).toBe(true);
  });

  it("is true with a project .env model key, which omp loads itself", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${LONG}\n`);
    expect(make().keys.hasModelProvider(dir)).toBe(true);
  });

  it("is false with only a search-group key", () => {
    const { keys } = make({ env: { BRAVE_API_KEY: LONG } });
    expect(keys.hasModelProvider(null)).toBe(false);
  });

  it("is false with no project when the key lives only in a project .env", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), `${KEY}=${LONG}\n`);
    expect(make().keys.hasModelProvider(null)).toBe(false);
  });
});
