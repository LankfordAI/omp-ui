import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseTreeSnapshot,
  TREE_COMMAND,
  TREE_PREVIEW_CHAR_LIMIT,
  TREE_STATUS_KEY,
  type TreeSnapshot,
} from "./session-tree";
import { treeExtensionPath, writeTreeExtension } from "./tree-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: Record<string, unknown>;
  summary?: string;
  shortSummary?: string;
  firstKeptEntryId?: string;
}

function userEntry(id: string, parentId: string | null, text: string): Entry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantEntry(id: string, parentId: string | null, text: string): Entry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-28T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

/** Mirrors omp's SessionManager tree nodes: {entry, children}. */
function toNodes(entries: Entry[]): Record<string, unknown>[] {
  const nodes = new Map<string, Record<string, unknown>>();
  for (const entry of entries)
    nodes.set(entry.id, { entry, children: [] as Record<string, unknown>[] });
  const roots: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    const parentChildren =
      entry.parentId === null
        ? undefined
        : (nodes.get(entry.parentId)?.children as Record<string, unknown>[] | undefined);
    if (parentChildren === undefined) roots.push(node);
    else parentChildren.push(node);
  }
  return roots;
}

class FakeAgentSession {
  entries: Entry[];
  leafId: string;
  prompts: string[] = [];
  navigateCalls: { entryId: string; summarize: boolean }[] = [];
  listeners: ((event: { type: string; [key: string]: unknown }) => void)[] = [];
  isStreaming = false;
  isCompacting = false;
  /** navigateTree's behavior; tests replace it for refusal cases. */
  onNavigate: (entryId: string) => { cancelled?: boolean } | Error = () => ({
    cancelled: false,
  });
  sessionManager: Record<string, unknown>;
  navigateTree?: (entryId: string, options: { summarize: boolean }) => Promise<unknown>;

  constructor(entries: Entry[], leafId: string, options: { without?: string[] } = {}) {
    this.entries = entries;
    this.leafId = leafId;
    this.sessionManager = {
      getTree: () => toNodes(this.entries),
      getLeafId: () => this.leafId,
      getEntry: (id: string) => this.entries.find((entry) => entry.id === id) ?? undefined,
    };
    this.navigateTree = (entryId, treeOptions) => {
      this.navigateCalls.push({ entryId, summarize: treeOptions.summarize });
      const behavior = this.onNavigate(entryId);
      if (behavior instanceof Error) return Promise.reject(behavior);
      this.leafId = entryId;
      return Promise.resolve(behavior);
    };
    for (const name of options.without ?? []) delete this.sessionManager[name];
    // `navigateTree` lives on the instance like omp's real method; removing
    // it simulates an older build that never had it.
    if ((options.without ?? []).includes("navigateTree")) this.navigateTree = undefined;
  }

  prompt(text: string): Promise<boolean> {
    this.prompts.push(text);
    return Promise.resolve(true);
  }

  subscribe(listener: (event: { type: string }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  fire(event: { type: string; [key: string]: unknown }): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface Harness {
  arm: (args?: string) => Promise<void>;
  snapshot: () => TreeSnapshot;
  statuses: TreeSnapshot[];
  /** The class the generated prototype hook rewrote; its prompt binds root. */
  AgentSession: typeof FakeAgentSession;
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-tree-"));
  dirs.push(dir);
  const file = writeTreeExtension(dir);
  expect(file).toBe(treeExtensionPath(dir));
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated tree extension has no default factory");

  const statuses: TreeSnapshot[] = [];
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
  const api: Record<string, unknown> = {
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, opts: { handler: typeof handler }): void => {
      expect(name).toBe(TREE_COMMAND);
      handler = opts.handler;
    },
  };
  factory(api);

  return {
    arm: async (args = ""): Promise<void> => {
      if (!handler) throw new Error("generated extension registered no command");
      await handler(args, {
        ui: {
          setStatus: (key: string, text: string | undefined): void => {
            expect(key).toBe(TREE_STATUS_KEY);
            const snapshot = parseTreeSnapshot(text ?? "");
            if (snapshot === null)
              throw new Error("published a snapshot the shared wire parser rejects");
            statuses.push(snapshot);
          },
        },
      });
    },
    snapshot: (): TreeSnapshot => {
      const value = statuses.at(-1);
      if (value === undefined) throw new Error("the bridge published no snapshot");
      return value;
    },
    statuses,
    AgentSession: FakeAgentSession,
  };
}

const LINEAR = [
  userEntry("e1", null, "first prompt"),
  assistantEntry("e2", "e1", "answer one"),
  userEntry("e3", "e2", "a second prompt that repeats a second prompt that repeats"),
];

/** A session whose root prompt already ran (binding) and whose bridge is armed. */
async function armed(
  entries = LINEAR,
  leafId = "e3",
  options: { without?: string[] } = {},
): Promise<Harness & { session: FakeAgentSession }> {
  const h = harness();
  const session = new FakeAgentSession(entries, leafId, options);
  // The generated prototype hook binds the root on the first prompt — call
  // the rewritten prototype directly, the way omp's runtime would.
  const bound = h.AgentSession.prototype.prompt as unknown as (
    this: FakeAgentSession,
    text: string,
  ) => Promise<boolean>;
  await bound.call(session, "hello");
  await h.arm("show");
  return { ...h, session };
}

// --------------------------------------------------------------------- tests

describe("tree extension", () => {
  it("writes a strict TypeScript extension omp can load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-tree-check-"));
    dirs.push(dir);
    typecheckGeneratedExtension(writeTreeExtension(dir));
  });

  it("publishes the whole tree with the active path and previews", async () => {
    const h = await armed();
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.leafId).toBe("e3");
    expect(snapshot.activePath).toEqual(["e1", "e2", "e3"]);
    expect(snapshot.nodes.map((n) => [n.id, n.parentId, n.type, n.role, n.text])).toEqual([
      ["e1", null, "message", "user", "first prompt"],
      ["e2", "e1", "message", "assistant", "answer one"],
      [
        "e3",
        "e2",
        "message",
        "user",
        "a second prompt that repeats a second prompt that repeats",
      ],
    ]);
  });

  it("caps previews at the wire limit and reads compaction summaries", async () => {
    const long = "x".repeat(TREE_PREVIEW_CHAR_LIMIT + 50);
    const h = await armed(
      [
        userEntry("e1", null, long),
        {
          type: "compaction",
          id: "e2",
          parentId: "e1",
          timestamp: "t",
          summary: "full summary",
          shortSummary: "compact summary",
          firstKeptEntryId: "e1",
        },
      ],
      "e2",
    );
    const [first, second] = h.snapshot().nodes;
    expect(first?.text).toHaveLength(TREE_PREVIEW_CHAR_LIMIT);
    expect(second?.type).toBe("compaction");
    expect(second?.text).toBe("compact summary");
  });

  it("publishes missing-api when the manager exposes no getTree", async () => {
    const h = await armed(LINEAR, "e3", { without: ["getTree"] });
    expect(h.snapshot()).toMatchObject({ available: false, reason: "missing-api" });
  });

  it("publishes read-failed when getTree answers with a throw", async () => {
    const h = await armed();
    h.session.sessionManager.getTree = () => {
      throw new Error("tree exploded");
    };
    await h.arm("show");
    expect(h.snapshot()).toMatchObject({ available: false, reason: "read-failed" });
  });

  it("re-publishes on agent_end with a monotonic revision", async () => {
    const h = await armed();
    const first = h.snapshot().revision;
    h.session.entries.push(userEntry("e4", "e3", "next prompt"));
    h.session.leafId = "e4";
    h.session.fire({ type: "agent_end" });
    const second = h.snapshot();
    expect(second.revision).toBe(first + 1);
    expect(second.leafId).toBe("e4");
    h.session.fire({ type: "tool_execution_end" });
    // An irrelevant event never republishes: revisions only move on real changes.
    expect(h.statuses.at(-1)!.revision).toBe(second.revision);
  });

  it("navigates and publishes the success result", async () => {
    const h = await armed([...LINEAR, userEntry("e5", "e2", "abandoned sibling")], "e3");
    await h.arm("navigate e5");
    expect(h.session.navigateCalls).toEqual([{ entryId: "e5", summarize: false }]);
    expect(h.snapshot()).toMatchObject({
      leafId: "e5",
      navigation: { entryId: "e5", ok: true },
    });
  });

  it("passes summarize through to navigateTree", async () => {
    const h = await armed();
    await h.arm("navigate e1 summarize");
    expect(h.session.navigateCalls).toEqual([{ entryId: "e1", summarize: true }]);
    expect(h.snapshot().navigation).toMatchObject({ entryId: "e1", ok: true });
  });

  it("refuses navigation while the session is streaming", async () => {
    const h = await armed();
    h.session.isStreaming = true;
    await h.arm("navigate e1");
    expect(h.session.navigateCalls).toHaveLength(0);
    expect(h.snapshot().navigation).toMatchObject({
      entryId: "e1",
      ok: false,
      error: "Stop the current turn before navigating the session tree.",
    });
  });

  it("reports a navigateTree rejection in the snapshot, not a crash", async () => {
    const h = await armed();
    h.session.onNavigate = () => new Error("Entry nope not found");
    await h.arm("navigate nope");
    expect(h.snapshot().navigation).toMatchObject({
      entryId: "nope",
      ok: false,
      error: "Error: Entry nope not found",
    });
  });

  it("marks a hook-cancelled navigation aborted and not ok", async () => {
    const h = await armed();
    h.session.onNavigate = () => ({ cancelled: true });
    await h.arm("navigate e1");
    expect(h.snapshot().navigation).toMatchObject({
      entryId: "e1",
      ok: false,
      aborted: true,
    });
  });

  it("publishes missing-api when navigateTree is absent — old omp still prompts", async () => {
    const h = await armed(LINEAR, "e3", { without: ["navigateTree"] });
    await h.arm("navigate e1");
    expect(h.snapshot().available).toBe(false);
    expect(h.snapshot().reason).toBe("missing-api");
  });

  it("an unknown subcommand still publishes rather than failing the arm", async () => {
    const h = await armed();
    const before = h.statuses.length;
    await h.arm("wat");
    expect(h.statuses.length).toBe(before + 1);
    expect(h.snapshot().available).toBe(true);
  });
});
