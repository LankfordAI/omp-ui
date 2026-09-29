import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, type CollabCliResult, type CollabTabSnapshot, type CollabTabState } from "@omp-ui/core";
import { CollabTracker, COLLAB_POLL_MS, type CollabLivePty } from "./collab-tracker";

const ROW = (over: Record<string, unknown> = {}) => ({
  instanceId: "inst",
  pid: 100,
  generation: 1,
  sessionId: "s",
  sessionName: "",
  cwd: "/p",
  model: "m",
  startedAt: "",
  participants: 1,
  access: "full",
  relayConnected: true,
  inputRequired: false,
  busy: false,
  ...over,
});

const STATE = (over: Partial<CollabTabState> = {}): CollabTabState => ({
  status: "full",
  generation: 1,
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  ...over,
});

interface Harness {
  tracker: CollabTracker;
  entries: CollabLivePty[];
  written: string[];
  sent: Array<[string, unknown[]]>;
  setRows(rows: unknown[] | null): void;
  setLink(result: CollabCliResult): void;
}

function harness(opts: { settleMs?: number } = {}): Harness {
  const entries: CollabLivePty[] = [{ tabId: "t1", pid: 100 }];
  const written: string[] = [];
  const sent: Array<[string, unknown[]]> = [];
  let rows: unknown[] | null = [];
  let link: CollabCliResult = { stdout: JSON.stringify({ url: "https://my.omp.sh/s#k" }), stderr: "", code: 0 };
  const tracker = new CollabTracker({
    getOmpPath: () => "/bin/omp",
    livePtyEntries: () => entries,
    writePty: (tabId, data) => written.push(`${tabId}:${data}`),
    send: (channel, ...args) => sent.push([channel, args]),
    cli: {
      exec: (_omp, argv) => {
        if (argv[1] === "list") {
          return Promise.resolve(
            rows === null
              ? { stdout: "", stderr: "boom", code: 1 }
              : { stdout: JSON.stringify({ version: 1, hosts: rows }), stderr: "", code: 0 },
          );
        }
        return Promise.resolve(link);
      },
    },
    settleMs: opts.settleMs ?? 6_000,
  });
  return {
    tracker,
    entries,
    written,
    sent,
    setRows: (next) => {
      rows = next;
    },
    setLink: (next) => {
      link = next;
    },
  };
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CollabTracker polling", () => {
  it("idles while no PTY tab is live and starts on the first one", async () => {
    const h = harness();
    h.entries.length = 0;
    h.tracker.noteLiveChange();
    await advance(COLLAB_POLL_MS * 3);
    expect(h.sent).toEqual([]);
    h.entries.push({ tabId: "t1", pid: 100 });
    h.tracker.noteLiveChange();
    await advance(COLLAB_POLL_MS);
    expect(h.sent).toEqual([[CH.onCollabChanged, ["t1", null]]]);
  });

  it("broadcasts a hosting row once and stays quiet while unchanged", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    expect(h.sent).toEqual([[CH.onCollabChanged, ["t1", STATE()]]]);
    await advance(COLLAB_POLL_MS * 2);
    expect(h.sent).toHaveLength(1);
  });

  it("ignores rows whose pid is not a live PTY child", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.setRows([ROW({ pid: 999 })]);
    await advance(COLLAB_POLL_MS);
    expect(h.sent.filter((s) => s[1][1] !== null)).toEqual([]);
  });

  it("re-broadcasts on the generation rotation a session switch causes", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    h.setRows([ROW({ generation: 2, access: "view", participants: 0 })]);
    await advance(COLLAB_POLL_MS);
    expect(h.sent.at(-1)).toEqual([
      CH.onCollabChanged,
      ["t1", STATE({ status: "view", generation: 2, participants: 0 })],
    ]);
  });

  it("holds the last snapshot when the registry probe fails", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    h.setRows(null);
    await advance(COLLAB_POLL_MS * 2);
    expect(h.sent).toHaveLength(1);
  });

  it("reports a departed tab off immediately and stops polling once none remain", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    h.entries.length = 0;
    h.tracker.noteLiveChange();
    expect(h.sent.at(-1)).toEqual([CH.onCollabChanged, ["t1", null]]);
    const before = h.sent.length;
    await advance(COLLAB_POLL_MS * 3);
    expect(h.sent).toHaveLength(before);
  });
});

describe("CollabTracker commands", () => {
  it("share writes the slash line and settles when the row appears", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    const settled = h.tracker.share("t1", "full");
    expect(h.written).toEqual(["t1:/collab\r"]);
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    await expect(settled).resolves.toBeUndefined();
  });

  it("share with view access writes `/collab view`", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    const settled = h.tracker.share("t1", "view");
    expect(h.written).toEqual(["t1:/collab view\r"]);
    h.setRows([ROW({ access: "view" })]);
    await advance(COLLAB_POLL_MS);
    await expect(settled).resolves.toBeUndefined();
  });

  it("share rejects after the settle window with no row", async () => {
    const h = harness({ settleMs: 6_000 });
    h.tracker.noteLiveChange();
    const settled = h.tracker.share("t1", "full");
    const refused = expect(settled).rejects.toThrow(/no Collab host appeared/);
    await advance(6_100);
    await refused;
  });

  it("a view->full switch settles only once the row carries full", async () => {
    const h = harness({ settleMs: 60_000 });
    h.tracker.noteLiveChange();
    h.setRows([ROW({ access: "view" })]);
    await advance(COLLAB_POLL_MS);
    const settled = h.tracker.share("t1", "full");
    await advance(COLLAB_POLL_MS);
    await vi.waitFor(() => expect(h.written).toEqual(["t1:/collab\r"]));
    let done = false;
    void settled.then(() => {
      done = true;
    });
    await advance(COLLAB_POLL_MS);
    expect(done).toBe(false);
    h.setRows([ROW({ access: "full" })]);
    await advance(COLLAB_POLL_MS);
    await expect(settled).resolves.toBeUndefined();
  });

  it("share rejects when the tab has no live terminal", async () => {
    const h = harness();
    await expect(h.tracker.share("gone", "full")).rejects.toThrow(/not a live terminal tab/);
    expect(h.written).toEqual([]);
  });

  it("an exiting tab fails its pending share immediately", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    const settled = h.tracker.share("t1", "full");
    h.entries.length = 0;
    h.tracker.noteLiveChange();
    await expect(settled).rejects.toThrow(/terminal ended/);
  });

  it("stop writes `/collab stop` and needs no settle", () => {
    const h = harness();
    h.tracker.noteLiveChange();
    h.tracker.stop("t1");
    expect(h.written).toEqual(["t1:/collab stop\r"]);
  });

  it("link asks omp for the pid's URL and surfaces refusals", async () => {
    const h = harness();
    h.tracker.noteLiveChange();
    await expect(h.tracker.link("t1", true)).resolves.toBe("https://my.omp.sh/s#k");
    h.setLink({ stdout: "", stderr: "error: no active Collab host matches 100", code: 1 });
    await expect(h.tracker.link("t1", false)).rejects.toThrow(
      "no active Collab host matches 100",
    );
  });
});

describe("CollabTracker snapshots", () => {
  it("answers one row per live PTY tab with its last known state", async () => {
    const h = harness();
    h.entries.push({ tabId: "t2", pid: 200 });
    h.tracker.noteLiveChange();
    h.setRows([ROW()]);
    await advance(COLLAB_POLL_MS);
    const snapshots: CollabTabSnapshot[] = h.tracker.snapshots();
    expect(snapshots).toEqual([
      { tabId: "t1", state: STATE() },
      { tabId: "t2", state: null },
    ]);
  });
});
