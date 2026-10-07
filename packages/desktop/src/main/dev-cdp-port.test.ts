import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseProcNetTcp,
  pickDevCdpPort,
  readPortSnapshot,
  writeDevCdpPortFile,
} from "./dev-cdp-port";

// Fixture mirrors /proc/net/tcp{,6} layout: header line, then entries
// "sl: local_address rem_address st ..." with st in hex.
// 0x1F90=8080 LISTEN, 0x2407=9223 TIME-WAIT, 0x04D2=1234 ESTABLISHED (01, ignored),
// IPv6 line 0x2410=9232 LISTEN.
const FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1",
  "   1: 0100007F:2407 0100007F:240A 06 00000000:00000000 00:00000000 00000000     0        0 2",
  "   2: 0100007F:04D2 0100007F:04D3 01 00000000:00000000 00:00000000 00000000     0        0 3",
  "",
].join("\n");

const FIXTURE6 = [
  "  sl  local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000000000000:2410 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4",
  "",
].join("\n");

describe("parseProcNetTcp", () => {
  it("collects only LISTEN and TIME-WAIT local ports", () => {
    const tcp = parseProcNetTcp(FIXTURE);
    expect(tcp.listening).toEqual(new Set([8080]));
    expect(tcp.timeWait).toEqual(new Set([9223]));
  });

  it("handles IPv6 address lines with multiple colons", () => {
    const tcp6 = parseProcNetTcp(FIXTURE6);
    expect(tcp6.listening).toEqual(new Set([9232]));
  });
});

describe("pickDevCdpPort", () => {
  const snap = parseProcNetTcp(FIXTURE);

  it("keeps the preferred port when it is free", () => {
    // 9300 appears in no fixture set: neither LISTEN nor TIME-WAIT.
    expect(pickDevCdpPort(9300, snap)).toBe(9300);
  });

  it("steps to the next free port when preferred is TIME-WAIT blocked", () => {
    const blocked = { listening: new Set<number>(), timeWait: new Set([9223]) };
    expect(pickDevCdpPort(9223, blocked)).toBe(9224);
  });

  it("skips a run of blocked ports to the first free one", () => {
    const blocked = { listening: new Set([9223, 9224, 9225]), timeWait: new Set<number>() };
    expect(pickDevCdpPort(9223, blocked)).toBe(9226);
  });

  it("returns the preferred port when every candidate is blocked", () => {
    const all = new Set<number>();
    for (let p = 9223; p <= 9239; p += 1) all.add(p);
    const blocked = { listening: all, timeWait: new Set<number>() };
    expect(pickDevCdpPort(9223, blocked)).toBe(9223);
  });

  it("keeps the preferred port when no snapshot is available", () => {
    expect(pickDevCdpPort(9223, null)).toBe(9223);
  });
});

describe("writeDevCdpPortFile", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("writes the port atomically and creates a missing userData dir", () => {
    const userData = mkdtempSync(join(tmpdir(), "cdp-port-test-"));
    dirs.push(userData);
    const nested = join(userData, "sub", "dir");
    writeDevCdpPortFile(9231, nested);
    expect(readFileSync(join(nested, "dev-cdp-port.txt"), "utf8")).toBe("9231\n");
    // No leftover .tmp file from the atomic rename.
    expect(readdirSync(nested)).toEqual(["dev-cdp-port.txt"]);
  });
});

describe("readPortSnapshot", () => {
  it("sees a locally bound LISTEN port on /proc systems", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      server.close();
      throw new Error("listen(0) did not yield an AddressInfo");
    }
    const port = addr.port;
    const snap = readPortSnapshot();
    server.close();
    // Non-Linux CI without /proc may return null; stay portable.
    if (snap === null) return;
    expect(snap.listening.has(port)).toBe(true);
  });
});
