import { isObject } from "./guards";
import type { LoginProvider } from "./provider-catalog";
import { RpcClient, type RpcSpawnFn } from "./rpc/client";

export interface ReadLoginProvidersOptions {
  ompPath: string | null;
  scratchDir: string;
  spawnProcess?: RpcSpawnFn;
  signal?: AbortSignal;
}

const DISCOVERY_ID = "provider-login-discovery";
const DISCOVERY_TIMEOUT_MS = 10_000;

function parseProviders(data: unknown): LoginProvider[] | null {
  if (!isObject(data) || Array.isArray(data) || !Array.isArray(data.providers)) return null;
  const providers: LoginProvider[] = [];
  for (const provider of data.providers) {
    if (
      !isObject(provider) ||
      Array.isArray(provider) ||
      typeof provider.id !== "string" ||
      provider.id.trim().length === 0 ||
      typeof provider.name !== "string" ||
      provider.name.trim().length === 0 ||
      typeof provider.available !== "boolean" ||
      typeof provider.authenticated !== "boolean"
    ) {
      return null;
    }
    providers.push({
      id: provider.id,
      name: provider.name,
      available: provider.available,
      authenticated: provider.authenticated,
    });
  }
  return providers;
}

/** Read only public sign-in metadata through a short-lived, session-less child. */
export function readLoginProviders(
  opts: ReadLoginProvidersOptions,
): Promise<LoginProvider[] | null> {
  if (opts.ompPath === null || opts.signal?.aborted) return Promise.resolve(null);
  const ompPath = opts.ompPath;

  // Executor form: the package's ES2022 lib predates Promise.withResolvers.
  return new Promise((resolve) => {
    let client: RpcClient | null = null;
    let settled = false;
    const settle = (providers: LoginProvider[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      client?.kill();
      resolve(providers);
    };
    const onAbort = (): void => settle(null);
    const timer = setTimeout(() => settle(null), DISCOVERY_TIMEOUT_MS);
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      client = new RpcClient({
        cwd: opts.scratchDir,
        lineageDir: opts.scratchDir,
        ompPath,
        bare: true,
        initialCommands: [{ type: "get_login_providers", id: DISCOVERY_ID }],
        spawnProcess: opts.spawnProcess,
        onFrame: (frame) => {
          if (settled || !isObject(frame)) return;
          if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
            client?.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
            return;
          }
          if (
            frame.type !== "response" ||
            frame.id !== DISCOVERY_ID ||
            frame.command !== "get_login_providers"
          ) {
            return;
          }
          settle(frame.success === true ? parseProviders(frame.data) : null);
        },
        onExit: () => settle(null),
        onError: () => settle(null),
      });
      // A synchronous child callback or abort may settle while the constructor runs.
      if (settled) client.kill();
    } catch {
      settle(null);
    }
  });
}
