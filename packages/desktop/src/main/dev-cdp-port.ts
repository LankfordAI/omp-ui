import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Ports held by LISTEN (0A) or TIME-WAIT (06) sockets per /proc/net/tcp{,6}. */
export interface PortSnapshot {
  listening: Set<number>;
  timeWait: Set<number>;
}

/** Parses /proc/net/tcp or /proc/net/tcp6 text; ignores header and foreign states. */
export function parseProcNetTcp(text: string): PortSnapshot {
  const listening = new Set<number>();
  const timeWait = new Set<number>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // Entry lines start with "sl:"; header lines do not.
    if (fields.length < 4 || !/^\d+:$/.test(fields[0] ?? "")) continue;
    // Local address is hex "IP:PORT" (IPv6 uses colons in the address: split on last ':').
    const localPort = Number.parseInt(
      fields[1]!.slice(fields[1]!.lastIndexOf(":") + 1),
      16,
    );
    const state = fields[3];
    if (state === "0A") listening.add(localPort);
    else if (state === "06") timeWait.add(localPort);
  }
  return { listening, timeWait };
}

/** Reads /proc/net/tcp and /proc/net/tcp6; null when absent (non-Linux) or unreadable. */
export function readPortSnapshot(): PortSnapshot | null {
  try {
    return parseProcNetTcp(
      readFileSync("/proc/net/tcp", "utf8") +
        "\n" +
        readFileSync("/proc/net/tcp6", "utf8"),
    );
  } catch {
    return null;
  }
}

/**
 * First port in preferred..preferred+range with no LISTEN or TIME-WAIT holder;
 * preferred itself when the snapshot is unavailable (cannot assess: keep today's
 * behavior) or every candidate is blocked. Port-number match is conservative for
 * a dev seam: worst case we move off a usable port.
 */
export function pickDevCdpPort(
  preferred: number,
  snapshot: PortSnapshot | null,
  range = 16,
): number {
  if (!snapshot) return preferred;
  const blocked = (p: number) => snapshot.listening.has(p) || snapshot.timeWait.has(p);
  for (let p = preferred; p <= preferred + range; p += 1) if (!blocked(p)) return p;
  return preferred;
}

/** Records the live CDP port for post-restart reconnect; atomic tmp+rename like window-state.ts. */
export function writeDevCdpPortFile(port: number, userData: string): void {
  mkdirSync(userData, { recursive: true });
  const target = join(userData, "dev-cdp-port.txt");
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${port}\n`);
  renameSync(tmp, target);
}
