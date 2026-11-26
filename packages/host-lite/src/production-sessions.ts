import * as fs from "node:fs";
import * as path from "node:path";
import {
  ompPinActive,
  ProviderKeys,
  ProviderOAuth,
  resolveOmpBinary,
  type FleetFinishOutcome,
  type FleetFinishRequest,
  type FleetSendOutcome,
  type FleetSendRequest,
  type FleetSessionRequest,
  type FleetSettleOutcome,
  type FleetStopOutcome,
  type Registry,
} from "@omp-ui/core";
import { loadSessionBundle } from "./bundle-artifact";
import type { LiteKeyCipher, LiteSessions } from "./seams";

/**
 * The production session cluster for the headless member (issue #1010): loads
 * the esbuild artifact of the CURRENT desktop session cluster
 * (`scripts/bundle-session.mjs` output — never a source fork) through the one
 * bundle boundary (`bundle-artifact.ts`) and wires the dependency bag a
 * windowless host needs. Serves through `LiteSessions`, so serve.ts stays
 * test-pure; the drift gate in the bundle script keeps this honest against
 * desktop changes (no source fork can drift silently).
 */

export interface ProductionSessionsDeps {
  registry: Registry;
  dataDir: string;
  version: string;
  /** Member's stable instance id (`<dataDir>/instance-id`), forwarded to routine dispatchers. */
  instanceId?: string;
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
  fleetSend?(req: FleetSendRequest): Promise<FleetSendOutcome>;
  fleetFinish?(req: FleetFinishRequest): Promise<FleetFinishOutcome>;
  fleetStop?(req: FleetSessionRequest): Promise<FleetStopOutcome>;
  fleetSettle?(req: FleetSessionRequest): Promise<FleetSettleOutcome>;
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
export function resolveOmp(env: NodeJS.ProcessEnv): string | null {
  const override = env.OMP_UI_LITE_OMP?.trim();
  if (override !== undefined && override !== "") return override;
  return resolveOmpBinary(env);
}

/** True when omp is pinned by either OMP_UI_OMP_PATH (desktop/container) or OMP_UI_LITE_OMP (host-lite). */
export function isLiteOmpPinned(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  if (ompPinActive(env, exists)) return true;
  const override = env.OMP_UI_LITE_OMP?.trim();
  return override !== undefined && override !== "" && exists(override);
}

/** True when running inside the official Host Lite container image (immutable image semantics). */
export function isLiteContainerized(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OMP_UI_LITE_CONTAINER?.trim().toLowerCase();
  return raw === "1" || raw === "true";
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
  providerKeys?: Pick<ProviderKeys, "setKey">,
): LiteSessions {
  const manager = base.sessions;
  const fleetSessions =
    manager.fleetSend !== undefined &&
    manager.fleetFinish !== undefined &&
    manager.fleetStop !== undefined &&
    manager.fleetSettle !== undefined
      ? {
          deliverSend: (req: FleetSendRequest) => manager.fleetSend!(req),
          deliverFinish: (req: FleetFinishRequest) => manager.fleetFinish!(req),
          deliverStop: (req: FleetSessionRequest) => manager.fleetStop!(req),
          deliverSettle: (req: FleetSessionRequest) => manager.fleetSettle!(req),
        }
      : undefined;
  return {
    ...base,
    activity: () => ({
      liveSessions: registry.sessions.filter((s) => manager.isLive(s.tabId)).length,
      runningTurns: registry.sessions.filter((s) => manager.isTurnRunning(s.tabId)).length,
    }),
    providerReady: (cwd: string) => manager.modelProviderReady(cwd),
    ...(fleetSessions !== undefined ? { fleetSessions } : {}),
    ...(providerKeys !== undefined
      ? {
          providerKeys: {
            install: (envName: string, value: string) => providerKeys.setKey(envName, value),
          },
        }
      : {}),
  };
}

export async function createProductionSessions(deps: ProductionSessionsDeps): Promise<LiteSessions> {
  const env = deps.env ?? process.env;
  const bundle = await loadSessionBundle<BundleModule>(deps.bundlePath);
  const keyCipher =
    deps.cipher === null
      ? { available: false, backend: "none", encrypt: (): Buffer => Buffer.alloc(0), decrypt: (): string => "" }
      : toCoreCipher(deps.cipher);
  const providerKeys = new ProviderKeys(path.join(deps.dataDir, "provider-keys.json"), keyCipher, env);
  const ompPath = resolveOmp(env);
  const providerOAuth = new ProviderOAuth({
    getOmpPath: () => ompPath,
    scratchDir: path.join(deps.dataDir, "oauth-probe"),
    send: () => {},
  });
  if (ompPath !== null) {
    void providerOAuth.refresh().catch((err: unknown) => {
      console.warn(`[host-lite] oauth provider probe failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const created = bundle.createSessionBundle({
    registry: deps.registry,
    registryFile: path.join(deps.dataDir, "registry.json"),
    providerKeys,
    ...(deps.instanceId === undefined ? {} : { instanceId: deps.instanceId }),
    env,
    hasOAuthProvider: () => providerOAuth.hasModelAccount(),
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
  const gated = withPlacementGates(created, deps.registry, providerKeys);
  return {
    ...gated,
    dispose: async () => {
      providerOAuth.dispose();
      await gated.dispose();
    },
  };
}
