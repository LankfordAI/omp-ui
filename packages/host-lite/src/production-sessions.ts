import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Registry } from "@omp-ui/core";
import { ProviderKeys } from "@omp-ui/core";
import type { LiteKeyCipher, LiteSessions } from "./seams";

/**
 * The production session cluster for the headless member (issue #1010): loads
 * the esbuild artifact of the CURRENT desktop session cluster
 * (`scripts/bundle-session.mjs` output — never a source fork) and wires the
 * dependency bag a windowless host needs. Serves through `LiteSessions`, so
 * serve.ts stays test-pure; the drift gate in the bundle script is what keeps
 * this honest against desktop changes.
 *
 * The artifact ships as plain JS with no checked-in types, and a static import
 * would hard-wire the desktop package graph into host-lite — forbidden by the
 * slice contract (desktop modules reach lite ONLY through this built bundle).
 * So the load is genuinely runtime-selected: dynamic import of a resolved path.
 */

export interface ProductionSessionsDeps {
  registry: Registry;
  dataDir: string;
  version: string;
  /**
   * S3's codec; ProviderKeys speaks core's Buffer-based `KeyCipher`, adapted
   * below. Null = keys from env only (writes refused). Boot passes the concrete
   * `LiteKeyCipher`, whose `backend` labels the chosen protector for display —
   * the seam interface carries no label, so the type names that one extra field.
   */
  cipher: (LiteKeyCipher & { backend: string }) | null;
  env?: NodeJS.ProcessEnv;
  /** Absolute path of the built bundle; default `<pkgRoot>/dist/session-bundle.mjs`. */
  bundlePath?: string;
}

/** The slice of SessionManager the placement gates call; the bundle exports the real thing. */
interface SessionsView {
  isLive(tabId: string): boolean;
  isTurnRunning(tabId: string): boolean;
  modelProviderReady(projectCwd: string): boolean;
}

/** A bundle module exposes only this entry (see src/session-bundle/entry.ts). */
interface BundleModule {
  createSessionBundle(input: Record<string, unknown>): LiteSessions & { sessions: SessionsView };
}

/**
 * Core's KeyCipher is Buffer-in/Buffer-out; the lite codec is single-line
 * strings (JSON-safe transport). The on-disk store base64s whatever encrypt
 * returns, so the adapter bridges encodings only — no format is invented.
 * `backend` labels the protector for display; it comes off the concrete cipher.
 */
export function toCoreCipher(lite: LiteKeyCipher & { backend: string }) {
  return {
    available: true,
    backend: lite.backend,
    encrypt: (plain: string): Buffer => Buffer.from(lite.encrypt(plain), "utf8"),
    decrypt: (blob: Buffer): string => lite.decrypt(blob.toString("utf8")),
  };
}

/** `omp` on PATH unless overridden; null makes spawns refuse with the desktop's message. */
function resolveOmp(env: NodeJS.ProcessEnv): string | null {
  const override = env.OMP_UI_LITE_OMP?.trim();
  if (override !== "") return override || null;
  const finder = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(finder, ["omp"], { encoding: "utf8", timeout: 5_000 });
  const line = probe.status === 0 ? probe.stdout.split(/\r?\n/)[0]?.trim() : "";
  return line === "" ? null : line;
}

/**
 * Add the #1010 placement-gate seam fields to a session bundle: exact desktop
 * semantics — live/turn counts scan registry records through the manager, and
 * the provider gate is `modelProviderReady` per project path. Extracted so the
 * wrapper is unit-testable without the built artifact.
 */
export function withPlacementGates(
  base: LiteSessions & { sessions: SessionsView },
  registry: Pick<Registry, "sessions">,
): LiteSessions {
  const manager = base.sessions;
  return {
    ...base,
    activity: () => ({
      liveSessions: registry.sessions.filter((s) => manager.isLive(s.tabId)).length,
      runningTurns: registry.sessions.filter((s) => manager.isTurnRunning(s.tabId)).length,
    }),
    providerReady: (cwd: string) => manager.modelProviderReady(cwd),
  };
}

export async function createProductionSessions(deps: ProductionSessionsDeps): Promise<LiteSessions> {
  const env = deps.env ?? process.env;
  const bundlePath =
    deps.bundlePath ?? fileURLToPath(new URL("../dist/session-bundle.mjs", import.meta.url));
  const bundle = (await import(bundlePath)) as BundleModule;
  const keyCipher =
    deps.cipher === null
      ? { available: false, backend: "none", encrypt: (): Buffer => Buffer.alloc(0), decrypt: (): string => "" }
      : toCoreCipher(deps.cipher);
  const providerKeys = new ProviderKeys(path.join(deps.dataDir, "provider-keys.json"), keyCipher, env);
  const ompPath = resolveOmp(env);
  const created = bundle.createSessionBundle({
    registry: deps.registry,
    registryFile: path.join(deps.dataDir, "registry.json"),
    providerKeys,
    getOmpPath: () => ompPath,
    getSessionsRoot: () => path.join(deps.dataDir, "sessions"),
    getArchiveRoot: () => path.join(deps.dataDir, "archive"),
    getWorktreesRoot: () => path.join(deps.dataDir, "worktrees"),
    getChatsRoot: () => path.join(deps.dataDir, "chats"),
    appVersion: deps.version,
    // Device panes stream to a renderer and JPEG-encode through nativeImage;
    // lite ships no pane channels (absent, not denied), so these picks only
    // need to keep SessionManager's internal construction from throwing.
    devicePane: {
      encodeJpeg: (): never => {
        throw new Error("device panes need a windowed host");
      },
      agentDeviceBin: async () => null,
      stateDir: () => path.join(deps.dataDir, "agent-device"),
    },
  });
  return withPlacementGates(created, deps.registry);
}
