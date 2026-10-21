/**
 * The fleet's SSH reachability check (issue #904): one TCP connect, no SSH
 * protocol, no credentials. True only when the port accepts a connection
 * inside the bound; every error, refusal, or timeout is false. Never rejects.
 */
import * as net from "node:net";
import { FLEET_SSH_PORT } from "@omp-ui/core";

export const SSH_PROBE_TIMEOUT_MS = 1_500;

/** Executor form, not Promise.withResolvers: the node tsconfig lib is ES2022 (fleet-dispatcher.ts `within`). */
export function probeSshPort(host: string, port = FLEET_SSH_PORT, timeoutMs = SSH_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
