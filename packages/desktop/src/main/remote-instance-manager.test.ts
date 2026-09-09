import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CH,
  RemoteInstanceStore,
  type ChannelTable,
  type KeyCipher,
  type ProjectGroup,
  type RemoteInstanceSummary,
  type SpawnRequest,
} from "@omp-ui/core";
import {
  hashRemotePassword,
  mintRemoteToken,
  passwordSessionCredential,
  startRemoteServer,
  type RemoteHost,
  type RemoteServerHandle,
} from "@omp-ui/server";
import { RemoteInstanceManager } from "./remote-instance-manager";
import { routeByTab } from "./remote-route";
import { ownedSessionRecord } from "./test/fixtures";

// Real servers, real sockets, injected clocks: every wait below is on an observed transition
// (a broadcast showing a status, a host-side handler firing), never a sleep.

const TOKEN = mintRemoteToken();
const REMOTE_INSTANCE_ID = "remote-app-id";
const REMOTE_VERSION = "9.9.9";

const fakeCipher: KeyCipher = {
  available: true,
  backend: "fake",
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

function projectGroups(paths: string[]): ProjectGroup[] {
  return paths.map((p, i) => ({
    project: {
      path: p,
      name: path.basename(p),
      addedAt: "2026-08-01T00:00:00.000Z",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
    },
    sessions: [
      {
        ...ownedSessionRecord({ tabId: i === 0 ? "t-remote" : `t-remote-${i}`, projectCwd: p }),
        title: "remote session",
        status: null,
        live: "live",
        pendingPlan: null,
        planSettle: null,
        streamStalled: false,
      },
    ],
  }));
}

interface FakeHost extends RemoteHost {
  readonly requests: Array<{ ch: string; args: unknown[] }>;
  readonly notified: Array<{ ch: string; args: unknown[] }>;
  /** Resolves with the next notify on `ch`; register before triggering it. */
  nextNotify(ch: string): Promise<unknown[]>;
  emit(channel: string, args: unknown[]): void;
  projects: ProjectGroup[];
  /** What `state:get` answers as `modelFavorites`; raw values exercise malformed input (#440). */
  favorites: unknown;
}

function fakeHost(
  opts: { identity?: boolean; instanceId?: string; favorites?: unknown } = {},
): FakeHost {
  const requests: FakeHost["requests"] = [];
  const notified: FakeHost["notified"] = [];
  const notifyWaiters: Array<{ ch: string; resolve: (args: unknown[]) => void }> = [];
  const sinks = new Set<(channel: string, args: unknown[]) => void>();
  const host: FakeHost = {
    requests,
    notified,
    projects: projectGroups(["/remote/a"]),
    favorites: opts.favorites ?? [],
    handlers: () => table,
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(channel, args) {
      for (const sink of sinks) sink(channel, args);
    },
    nextNotify(ch) {
      return new Promise((resolve) => notifyWaiters.push({ ch, resolve }));
    },
  };
  const record = (ch: string, args: unknown[]): void => {
    notified.push({ ch, args });
    const i = notifyWaiters.findIndex((w) => w.ch === ch);
    if (i !== -1) notifyWaiters.splice(i, 1)[0]!.resolve(args);
  };
  const table = {
    request: {
      ...(opts.identity === false
        ? {}
        : {
            [CH.getInstanceIdentity]: () => {
              requests.push({ ch: CH.getInstanceIdentity, args: [] });
              return { instanceId: opts.instanceId ?? REMOTE_INSTANCE_ID, version: REMOTE_VERSION };
            },
          }),
      [CH.getState]: () => ({ projects: host.projects, modelFavorites: host.favorites }),
      [CH.toggleFavorite]: (key: string) => {
        requests.push({ ch: CH.toggleFavorite, args: [key] });
      },
      [CH.terminateSession]: (tabId: string) => {
        requests.push({ ch: CH.terminateSession, args: [tabId] });
      },
      [CH.spawnSession]: (req: SpawnRequest) => {
        requests.push({ ch: CH.spawnSession, args: [req] });
        return { tabId: "t-remote" };
      },
    },
    notify: {
      [CH.tabViewed]: (clientId: string, tabId: string | null) => record(CH.tabViewed, [clientId, tabId]),
      [CH.ptyWrite]: (tabId: string, data: string) => record(CH.ptyWrite, [tabId, data]),
    },
  } as unknown as ChannelTable;
  return host;
}

const servers: RemoteServerHandle[] = [];

async function serve(
  host: FakeHost,
  opts: { port?: number; password?: { salt: string; hash: string } } = {},
): Promise<RemoteServerHandle> {
  const handle = await startRemoteServer({
    host,
    token: TOKEN,
    bind: "localhost",
    port: opts.port ?? 0,
    webRoot: "/nonexistent-web-root",
    password: opts.password ?? null,
  });
  servers.push(handle);
  return handle;
}

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface Harness {
  manager: RemoteInstanceManager;
  store: RemoteInstanceStore;
  file: string;
  sent: Array<{ channel: string; args: unknown[] }>;
  timers: FakeTimer[];
  broadcasts: number;
  /** Resolves once a broadcast shows summaries satisfying `pred` (or immediately if they already do). */
  until(pred: (s: RemoteInstanceSummary[]) => boolean): Promise<RemoteInstanceSummary[]>;
  /** Resolves with the next mirrored event on `channel`. */
  nextSent(channel: string): Promise<unknown[]>;
  /** Fires the most recent pending retry timer. */
  fireTimer(): void;
}

let base = "";
const managers: RemoteInstanceManager[] = [];

function harness(opts: { localInstanceId?: string; file?: string } = {}): Harness {
  const file = opts.file ?? path.join(base, "remote-instances.json");
  const store = new RemoteInstanceStore(file, fakeCipher);
  const sent: Harness["sent"] = [];
  const timers: FakeTimer[] = [];
  const waiters: Array<{ pred: (s: RemoteInstanceSummary[]) => boolean; resolve: (s: RemoteInstanceSummary[]) => void }> = [];
  const sentWaiters: Array<{ channel: string; resolve: (args: unknown[]) => void }> = [];
  const h = {
    store,
    file,
    sent,
    timers,
    broadcasts: 0,
  } as Harness;
  const manager = new RemoteInstanceManager({
    store,
    localInstanceId: () => opts.localInstanceId ?? "local-app-id",
    localVersion: "1.0.0",
    send: (channel, args) => {
      sent.push({ channel, args });
      const i = sentWaiters.findIndex((w) => w.channel === channel);
      if (i !== -1) sentWaiters.splice(i, 1)[0]!.resolve(args);
    },
    broadcast: async () => {
      h.broadcasts += 1;
      const s = manager.summaries();
      for (const w of waiters.splice(0)) {
        if (w.pred(s)) w.resolve(s);
        else waiters.push(w);
      }
    },
    setTimer: (fn, ms) => {
      const timer: FakeTimer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as FakeTimer).cleared = true;
    },
  });
  managers.push(manager);
  h.manager = manager;
  h.until = (pred) => {
    const now = manager.summaries();
    if (pred(now)) return Promise.resolve(now);
    return new Promise((resolve) => waiters.push({ pred, resolve }));
  };
  h.nextSent = (channel) => new Promise((resolve) => sentWaiters.push({ channel, resolve }));
  h.fireTimer = () => {
    const pending = timers.filter((t) => !t.cleared).at(-1);
    if (!pending) throw new Error("no pending retry timer");
    pending.cleared = true;
    pending.fn();
  };
  return h;
}

const status = (s: RemoteInstanceSummary["status"]) => (all: RemoteInstanceSummary[]) =>
  all.length > 0 && all.every((x) => x.status === s);

async function join(h: Harness, port: number, nickname = ""): Promise<RemoteInstanceSummary> {
  await h.manager.add({
    url: `http://127.0.0.1:${port}`,
    nickname,
    secret: { kind: "token", value: TOKEN },
  });
  const [summary] = await h.until((s) => s.some((x) => x.status !== "connecting"));
  return summary!;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-remote-instances-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.stop();
  for (const s of servers.splice(0)) await s.close();
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("joining", () => {
  it("adopts a token URL: default nickname, joined, version, projects, owned tabs, encrypted file", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();

    await h.manager.add({
      url: `http://127.0.0.1:${server.port}/?t=${TOKEN}`,
      nickname: "",
      secret: { kind: "token", value: "" },
    });
    const [summary] = await h.until(status("joined"));
    expect(summary).toMatchObject({
      nickname: `127.0.0.1:${server.port}`,
      url: `http://127.0.0.1:${server.port}`,
      status: "joined",
      error: null,
      version: REMOTE_VERSION,
    });
    expect(summary!.projects.map((g) => g.project.path)).toEqual(["/remote/a"]);
    expect(h.manager.ownerOf("t-remote")).toBe(summary!.id);
    expect(h.manager.ownerOf("t-local")).toBeNull();

    // The store asks for 0600; NTFS has no POSIX mode bits, where stat reports
    // 0o666 for every file, so the mode proves nothing on Windows (issue #425).
    if (process.platform !== "win32") {
      expect(fs.statSync(h.file).mode & 0o777).toBe(0o600);
    }
    const raw = fs.readFileSync(h.file, "utf8");
    expect(raw).not.toContain(TOKEN);
    const parsed = JSON.parse(raw) as { instances: Array<{ credential: string; url: string }> };
    expect(Buffer.from(parsed.instances[0]!.credential, "base64").toString("utf8")).toBe(TOKEN);
    expect(parsed.instances[0]!.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  it("signs in with a password and stores the derived credential, never the password", async () => {
    const password = hashRemotePassword("correct horse battery");
    const host = fakeHost();
    const server = await serve(host, { password });
    const h = harness();

    await h.manager.add({
      url: `http://127.0.0.1:${server.port}`,
      nickname: "box",
      secret: { kind: "password", value: "correct horse battery" },
    });
    await h.until(status("joined"));
    const [record] = h.store.list();
    expect(h.store.credential(record!.id)).toBe(passwordSessionCredential(password.hash));
    expect(fs.readFileSync(h.file, "utf8")).not.toContain("correct horse battery");
  });

  it("rejects a wrong password with the server's message and stores nothing", async () => {
    const host = fakeHost();
    const server = await serve(host, { password: hashRemotePassword("correct horse battery") });
    const h = harness();

    await expect(
      h.manager.add({
        url: `http://127.0.0.1:${server.port}`,
        nickname: "",
        secret: { kind: "password", value: "nope nope nope" },
      }),
    ).rejects.toThrow("Wrong password.");
    expect(h.store.list()).toEqual([]);
    expect(h.manager.summaries()).toEqual([]);
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it("marks its own instance as self, closes, and never retries", async () => {
    const host = fakeHost({ instanceId: "local-app-id" });
    const server = await serve(host);
    const h = harness({ localInstanceId: "local-app-id" });

    const summary = await join(h, server.port);
    expect(summary.status).toBe("self");
    expect(summary.error).toBeNull();
    expect(summary.projects).toEqual([]);
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
    expect(h.manager.ownerOf("t-remote")).toBeNull();
  });

  it("marks a remote without instance:identity as incompatible and never retries", async () => {
    const host = fakeHost({ identity: false });
    const server = await serve(host);
    const h = harness();

    const summary = await join(h, server.port);
    expect(summary.status).toBe("incompatible");
    expect(summary.error).toContain("older than this app");
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
  });

  it("refuses a duplicate nickname case-insensitively and leaves the store untouched", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();

    await join(h, server.port, "Box");
    await expect(
      h.manager.add({
        url: `http://127.0.0.1:${server.port}`,
        nickname: "box",
        secret: { kind: "token", value: TOKEN },
      }),
    ).rejects.toThrow('an instance named "Box" already exists');
    expect(h.store.list()).toHaveLength(1);
  });

  it("goes unreachable with a retry scheduled when the remote is down at join time", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const port = server.port;
    await server.close();
    servers.pop();
    const h = harness();

    const summary = await join(h, port);
    expect(summary.status).toBe("unreachable");
    expect(summary.error).not.toBeNull();
    expect(h.timers.map((t) => t.ms)).toEqual([1000]);
    expect(h.store.list()).toHaveLength(1);
  });
});

describe("proxy and routing", () => {
  it("routes a tab-scoped request to the owning instance and keeps local tabs local", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);

    const local = vi.fn();
    const spawnLocal = vi.fn(() => ({ tabId: "t-local-new" }));
    const table = {
      request: { [CH.terminateSession]: local, [CH.spawnSession]: spawnLocal },
      notify: {},
    } as unknown as ChannelTable;
    const routed = routeByTab(table, (id) => h.manager.ownerOf(id), h.manager);
    const request = routed.request as unknown as Record<string, (...a: unknown[]) => unknown>;

    await request[CH.terminateSession]!("t-remote");
    expect(host.requests.filter((r) => r.ch === CH.terminateSession)).toEqual([
      { ch: CH.terminateSession, args: ["t-remote"] },
    ]);
    expect(local).not.toHaveBeenCalled();

    await request[CH.terminateSession]!("t-local");
    expect(local).toHaveBeenCalledWith("t-local");

    const resume: SpawnRequest = { origin: "resume", resumeTabId: "t-remote", cols: 80, rows: 24 };
    await expect(request[CH.spawnSession]!(resume)).resolves.toEqual({ tabId: "t-remote" });
    expect(host.requests.filter((r) => r.ch === CH.spawnSession)).toHaveLength(1);
    expect(spawnLocal).not.toHaveBeenCalled();

    const fresh: SpawnRequest = {
      origin: "new",
      mode: "rpc-ui",
      projectCwd: "/remote/a",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: null,
    };
    await request[CH.spawnSession]!(fresh);
    expect(spawnLocal).toHaveBeenCalledOnce();

    expect(instance.id).toBe(h.manager.ownerOf("t-remote"));
  });

  it("refuses channels outside the allowlist and instances that are not joined", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);

    await expect(h.manager.request(instance.id, CH.setThemeId, ["nord"])).rejects.toThrow(
      `channel ${CH.setThemeId} is not proxied`,
    );
    await expect(h.manager.request("nope", CH.getState, [])).rejects.toThrow("unknown instance nope");
    await expect(h.manager.request(instance.id, CH.getState, [])).resolves.toMatchObject({
      projects: [{ project: { path: "/remote/a" } }],
    });

    await server.close();
    servers.pop();
    await h.until(status("unreachable"));
    await expect(h.manager.request(instance.id, CH.getState, [])).rejects.toThrow(
      `${instance.nickname} is not joined`,
    );
  });

  it("mirrors tab events unchanged, folds state:changed, and drops app-scoped events", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    await join(h, server.port);

    const bytes = new Uint8Array([1, 2, 3]);
    const mirrored = h.nextSent(CH.onPtyData);
    host.emit(CH.onAppUpdateState, [{ status: "idle" }]);
    host.emit(CH.onPtyData, ["t-remote", bytes]);
    const args = await mirrored;
    expect(args[0]).toBe("t-remote");
    expect(Array.from(args[1] as Uint8Array)).toEqual([1, 2, 3]);
    // Same socket, in order: the app event went by before the pty bytes and was dropped.
    expect(h.sent.map((s) => s.channel)).toEqual([CH.onPtyData]);

    const before = h.broadcasts;
    host.emit(CH.onStateChanged, [{ projects: projectGroups(["/remote/a", "/remote/b"]) }]);
    const [summary] = await h.until((s) => s[0]!.projects.length === 2);
    expect(summary!.projects.map((g) => g.project.path)).toEqual(["/remote/a", "/remote/b"]);
    expect(h.manager.ownerOf("t-remote-1")).toBe(summary!.id);
    expect(h.broadcasts).toBeGreaterThan(before);
    expect(h.sent.map((s) => s.channel)).toEqual([CH.onPtyData]);
  });

  it("forwards viewed-tab reports to the owning instance and clears them on switch-away", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    await join(h, server.port);

    let viewed = host.nextNotify(CH.tabViewed);
    h.manager.forwardViewed("c1", "t-remote");
    expect(await viewed).toEqual(["c1", "t-remote"]);

    viewed = host.nextNotify(CH.tabViewed);
    h.manager.forwardViewed("c1", "t-local");
    expect(await viewed).toEqual(["c1", null]);

    // Local → null: nothing to tell any instance. A round trip proves the socket is drained.
    h.manager.forwardViewed("c1", null);
    await h.manager.request(h.manager.summaries()[0]!.id, CH.getState, []);
    expect(host.notified.filter((n) => n.ch === CH.tabViewed)).toHaveLength(2);
  });
});

// Issue #440: a palette owned by a remote instance must follow that instance's
// favorites, so the manager mirrors them into the summary and the proxy
// allowlist admits favorites:toggle — and still nothing else app-scoped.
describe("remote model favorites", () => {
  it("hydrates only string favorites at join", async () => {
    const host = fakeHost({ favorites: ["anthropic/claude-opus-5", 42, "openai/gpt-4o"] });
    const server = await serve(host);
    const h = harness();

    const instance = await join(h, server.port);
    expect(instance.modelFavorites).toEqual(["anthropic/claude-opus-5", "openai/gpt-4o"]);
    expect(instance.projects.map((g) => g.project.path)).toEqual(["/remote/a"]);
  });

  it("joins with [] when the remote's first favorites payload is malformed", async () => {
    const host = fakeHost({ favorites: 42 });
    const server = await serve(host);
    const h = harness();

    const instance = await join(h, server.port);
    expect(instance.modelFavorites).toEqual([]);
    expect(instance.projects.map((g) => g.project.path)).toEqual(["/remote/a"]);
  });

  it("folds a favorites-only state:changed without replacing projects, and vice versa", async () => {
    const host = fakeHost({ favorites: ["openai/gpt-4o"] });
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);

    host.emit(CH.onStateChanged, [{ modelFavorites: ["anthropic/claude-opus-5"] }]);
    // Same socket, in order: a round trip proves the change was folded before the reply.
    await h.manager.request(instance.id, CH.getState, []);
    const favoritesOnly = h.manager.summaries()[0]!;
    expect(favoritesOnly.modelFavorites).toEqual(["anthropic/claude-opus-5"]);
    expect(favoritesOnly.projects.map((g) => g.project.path)).toEqual(["/remote/a"]);
    expect(h.manager.ownerOf("t-remote")).toBe(instance.id);

    host.emit(CH.onStateChanged, [{ projects: projectGroups(["/remote/a", "/remote/b"]) }]);
    const [projectsOnly] = await h.until((s) => s[0]!.projects.length === 2);
    expect(projectsOnly!.modelFavorites).toEqual(["anthropic/claude-opus-5"]);
    expect(projectsOnly!.projects.map((g) => g.project.path)).toEqual(["/remote/a", "/remote/b"]);
  });

  it("keeps the last good favorites when a later payload's favorites are malformed", async () => {
    const host = fakeHost({ favorites: ["openai/gpt-4o"] });
    const server = await serve(host);
    const h = harness();
    await join(h, server.port);

    host.emit(CH.onStateChanged, [
      { projects: projectGroups(["/remote/a", "/remote/b"]), modelFavorites: 42 },
    ]);
    const [summary] = await h.until((s) => s[0]!.projects.length === 2);
    expect(summary!.modelFavorites).toEqual(["openai/gpt-4o"]);
    expect(summary!.projects.map((g) => g.project.path)).toEqual(["/remote/a", "/remote/b"]);
  });

  it("forwards favorites:toggle to the owning instance and still refuses settings:setTheme", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);

    await h.manager.request(instance.id, CH.toggleFavorite, ["anthropic/claude-opus-5"]);
    expect(host.requests.filter((r) => r.ch === CH.toggleFavorite)).toEqual([
      { ch: CH.toggleFavorite, args: ["anthropic/claude-opus-5"] },
    ]);

    await expect(h.manager.request(instance.id, CH.setThemeId, ["nord"])).rejects.toThrow(
      `channel ${CH.setThemeId} is not proxied`,
    );
  });
});

describe("loss and recovery", () => {
  it("keeps projects while unreachable, rejoins on the retry timer, and resets the backoff", async () => {
    const host = fakeHost();
    let server = await serve(host);
    const port = server.port;
    const h = harness();
    const instance = await join(h, port);

    await server.close();
    servers.pop();
    const [down] = await h.until(status("unreachable"));
    expect(down!.error).toBe("connection lost");
    expect(down!.projects.map((g) => g.project.path)).toEqual(["/remote/a"]);
    expect(h.manager.ownerOf("t-remote")).toBe(instance.id);
    expect(h.timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([1000]);

    // The remote stays down through the first retry: backoff doubles.
    h.fireTimer();
    await h.until(status("connecting"));
    await h.until(status("unreachable"));
    expect(h.timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([2000]);

    server = await serve(host, { port });
    h.fireTimer();
    const [up] = await h.until(status("joined"));
    expect(up!.error).toBeNull();
    expect(up!.version).toBe(REMOTE_VERSION);
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);

    // Attempt counter reset by the join: the next loss starts the schedule over at 1s.
    await server.close();
    servers.pop();
    await h.until(status("unreachable"));
    expect(h.timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([1000]);
  });

  it("reconnect() cancels the pending retry and dials at once from unreachable", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const port = server.port;
    const h = harness();
    const instance = await join(h, port);
    await server.close();
    servers.pop();
    await h.until(status("unreachable"));
    const pending = h.timers.at(-1)!;

    await serve(host, { port });
    await h.manager.reconnect(instance.id);
    expect(pending.cleared).toBe(true);
    expect(h.manager.summaries()[0]!.status).toBe("joined");
  });

  it("stop() closes the socket and schedules nothing", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    await join(h, server.port);

    h.manager.stop();
    // The 1000 close the manager sent must not be read back as a loss that schedules a retry.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
    expect(h.manager.summaries()[0]!.status).toBe("joined");
  });
});

describe("editing", () => {
  it("renames in place: same id, still joined, no second handshake", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port, "old");
    const handshakes = host.requests.filter((r) => r.ch === CH.getInstanceIdentity).length;

    await h.manager.update(instance.id, { nickname: "new" });
    const [summary] = h.manager.summaries();
    expect(summary).toMatchObject({ id: instance.id, nickname: "new", status: "joined" });
    expect(h.store.list()[0]!.nickname).toBe("new");
    expect(host.requests.filter((r) => r.ch === CH.getInstanceIdentity)).toHaveLength(handshakes);
  });

  it("a secret change stores the new credential and reconnects", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);
    const handshakes = host.requests.filter((r) => r.ch === CH.getInstanceIdentity).length;

    await h.manager.update(instance.id, { secret: { kind: "token", value: "stale-token" } });
    expect(h.store.credential(instance.id)).toBe("stale-token");
    expect(h.manager.summaries()[0]!.status).toBe("needs-sign-in");
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);

    await h.manager.update(instance.id, { secret: { kind: "token", value: TOKEN } });
    expect(h.manager.summaries()[0]!.status).toBe("joined");
    expect(host.requests.filter((r) => r.ch === CH.getInstanceIdentity)).toHaveLength(handshakes + 1);
  });

  it("remove() forgets the record and credential and stops owning its tabs", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const h = harness();
    const instance = await join(h, server.port);

    await h.manager.remove(instance.id);
    expect(h.manager.summaries()).toEqual([]);
    expect(h.store.list()).toEqual([]);
    expect(h.manager.ownerOf("t-remote")).toBeNull();
    await expect(h.manager.request(instance.id, CH.getState, [])).rejects.toThrow("unknown instance");
  });

  it("start() dials stored records, flagging one whose credential no longer decrypts", async () => {
    const host = fakeHost();
    const server = await serve(host);
    const seeded = harness();
    await join(seeded, server.port, "kept");
    seeded.manager.stop();

    // Second instance record with a blob the cipher cannot read.
    const raw = JSON.parse(fs.readFileSync(seeded.file, "utf8")) as {
      instances: Array<Record<string, unknown>>;
    };
    raw.instances.push({
      id: "broken",
      nickname: "broken",
      url: "http://127.0.0.1:1",
      addedAt: "2026-08-01T00:00:00.000Z",
      credential: "",
    });
    fs.writeFileSync(seeded.file, JSON.stringify(raw));

    const h = harness({ file: seeded.file });
    expect(h.manager.summaries().map((s) => s.status)).toEqual(["connecting", "connecting"]);
    h.manager.start();
    const all = await h.until(
      (s) => s[0]!.status === "joined" && s[1]!.status === "needs-sign-in",
    );
    expect(all[1]!.error).toBe("stored credential could not be read");
    expect(h.timers.filter((t) => !t.cleared)).toEqual([]);
  });
});

describe("duplicate tab ids", () => {
  it("resolves to the first joined instance and warns once per id", async () => {
    const hostA = fakeHost({ instanceId: "a" });
    const hostB = fakeHost({ instanceId: "b" });
    const serverA = await serve(hostA);
    const serverB = await serve(hostB);
    const h = harness();
    await join(h, serverA.port, "a");
    await h.manager.add({
      url: `http://127.0.0.1:${serverB.port}`,
      nickname: "b",
      secret: { kind: "token", value: TOKEN },
    });
    await h.until((s) => s.length === 2 && s.every((x) => x.status === "joined"));

    const [a] = h.manager.summaries();
    expect(h.manager.ownerOf("t-remote")).toBe(a!.id);
    const warnings = vi.mocked(console.warn).mock.calls.filter((c) =>
      String(c[0]).includes("t-remote"),
    );
    expect(warnings).toHaveLength(1);

    // A refresh from B re-adopts the same id: no second warning.
    hostB.emit(CH.onStateChanged, [{ projects: projectGroups(["/remote/a", "/remote/z"]) }]);
    await h.until((s) => s[1]!.projects.length === 2);
    expect(
      vi.mocked(console.warn).mock.calls.filter((c) => String(c[0]).includes("t-remote")),
    ).toHaveLength(1);
  });
});
