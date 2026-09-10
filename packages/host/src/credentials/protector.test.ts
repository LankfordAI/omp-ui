import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxSecretServiceProtector, SECRET_SCHEMA, type SecretServiceAddon } from "./linux-secret-service";
import { KEYCHAIN_SERVICE, macosKeychainProtector, type KeychainEntry } from "./macos-keychain";
import { selectProtector } from "./protector";
import { MASTER_KEY_FILE, windowsDpapiProtector, type DpapiBindings } from "./windows-dpapi";

const DATA_ROOT = "/home/u/.local/share/omp-ui";
const DEK = Buffer.alloc(32, 7);

const tmpDirs: string[] = [];
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-dpapi-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("selectProtector", () => {
  it("picks the platform's store and threads the seam through", async () => {
    const entries = new Map<string, string>();
    const entryFactory = (service: string, account: string): KeychainEntry => ({
      getPassword: () => entries.get(`${service}\0${account}`) ?? null,
      setPassword: (password) => void entries.set(`${service}\0${account}`, password),
    });
    expect(selectProtector(DATA_ROOT, "linux").backend).toBe("linux-secret-service");
    expect(selectProtector(DATA_ROOT, "win32").backend).toBe("windows-dpapi");
    const mac = selectProtector(DATA_ROOT, "darwin", { darwin: { entryFactory } });
    expect(mac.backend).toBe("macos-keychain");
    await mac.store(DEK);
    expect(entries.get(`${KEYCHAIN_SERVICE}\0${DATA_ROOT}`)).toBe(DEK.toString("base64"));
  });

  it("refuses an unsupported platform from load and store", async () => {
    const p = selectProtector(DATA_ROOT, "freebsd");
    expect(p.backend).toBe("unsupported");
    await expect(p.load()).rejects.toThrow("unsupported platform");
    await expect(p.store(DEK)).rejects.toThrow("unsupported platform");
  });
});

describe("macosKeychainProtector", () => {
  function fakeKeychain(initial: string | null) {
    const state = { password: initial, accounts: [] as string[] };
    const entryFactory = (service: string, account: string): KeychainEntry => {
      state.accounts.push(`${service}/${account}`);
      return {
        getPassword: () => state.password,
        setPassword: (password) => void (state.password = password),
      };
    };
    return { state, entryFactory };
  }

  it("files the DEK base64 under the host service and the data root", async () => {
    const { state, entryFactory } = fakeKeychain(null);
    const p = macosKeychainProtector(DATA_ROOT, { entryFactory });
    expect(await p.load()).toBeNull();
    await p.store(DEK);
    expect(state.password).toBe(DEK.toString("base64"));
    expect(await p.load()).toEqual(DEK);
    expect(state.accounts).toEqual(Array(3).fill(`${KEYCHAIN_SERVICE}/${DATA_ROOT}`));
  });

  it("rejects a keychain item that is not a base64 key", async () => {
    const p = macosKeychainProtector(DATA_ROOT, { entryFactory: fakeKeychain("not base64!!").entryFactory });
    await expect(p.load()).rejects.toThrow("not a base64 key");
  });

  it("propagates a locked keychain as the thrown reason", async () => {
    const entryFactory = (): KeychainEntry => ({
      getPassword: () => {
        throw new Error("The user name or passphrase you entered is not correct.");
      },
      setPassword: () => {},
    });
    await expect(macosKeychainProtector(DATA_ROOT, { entryFactory }).load()).rejects.toThrow("passphrase");
  });
});

describe("windowsDpapiProtector", () => {
  /** XOR "DPAPI": reversible, and visibly not the plaintext on disk. */
  const dpapi: DpapiBindings = {
    protectData: (plain) => plain.map((b) => b ^ 0x5a),
    unprotectData: (blob) => blob.map((b) => b ^ 0x5a),
  };

  it("wraps the DEK into a 0600 master.key and unwraps it on load", async () => {
    const root = mkTmp();
    const p = windowsDpapiProtector(root, { dpapi });
    expect(await p.load()).toBeNull();
    await p.store(DEK);
    const file = path.join(root, MASTER_KEY_FILE);
    const onDisk = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    expect(onDisk.equals(DEK)).toBe(false);
    expect(onDisk.equals(Buffer.from(dpapi.protectData(DEK, null, "CurrentUser") as Uint8Array))).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await p.load()).toEqual(DEK);
  });

  it("rejects a master.key that is not a DPAPI blob", async () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, MASTER_KEY_FILE), "\n");
    await expect(windowsDpapiProtector(root, { dpapi }).load()).rejects.toThrow("not a base64 DPAPI blob");
  });

  it("propagates a DPAPI failure as the thrown reason", async () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, MASTER_KEY_FILE), Buffer.from([1, 2, 3]).toString("base64"));
    const broken: DpapiBindings = {
      protectData: dpapi.protectData,
      unprotectData: () => {
        throw new Error("Key not valid for use in specified state.");
      },
    };
    await expect(windowsDpapiProtector(root, { dpapi: broken }).load()).rejects.toThrow("Key not valid");
  });
});

describe("linuxSecretServiceProtector", () => {
  function fakeAddon(initial: Buffer | null) {
    const calls: unknown[][] = [];
    const state = { secret: initial };
    const addon: SecretServiceAddon = {
      lookup: (schema, attributes) => {
        calls.push(["lookup", schema, attributes]);
        return state.secret;
      },
      store: (schema, label, attributes, secret) => {
        calls.push(["store", schema, label, attributes]);
        state.secret = secret;
      },
    };
    return { addon, calls, state };
  }

  it("looks up and stores under the host schema with the dataRoot attribute", async () => {
    const { addon, calls } = fakeAddon(null);
    const p = linuxSecretServiceProtector(DATA_ROOT, { addon });
    expect(await p.load()).toBeNull();
    await p.store(DEK);
    expect(await p.load()).toEqual(DEK);
    expect(calls[0]).toEqual(["lookup", SECRET_SCHEMA, { dataRoot: DATA_ROOT }]);
    expect(calls[1]).toEqual(["store", SECRET_SCHEMA, `omp-ui host key (${DATA_ROOT})`, { dataRoot: DATA_ROOT }]);
  });

  it("prefixes an addon failure so the degraded reason names the store", async () => {
    const addon: SecretServiceAddon = {
      lookup: () => {
        throw new Error("Cannot autolaunch D-Bus without X11 $DISPLAY");
      },
      store: () => {},
    };
    await expect(linuxSecretServiceProtector(DATA_ROOT, { addon }).load()).rejects.toThrow(
      "secret service: Cannot autolaunch D-Bus",
    );
  });
});
