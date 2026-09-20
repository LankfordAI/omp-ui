import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_PANE_COMMAND,
  BROWSER_PANE_CUSTOM_TYPE,
  browserPaneInstruction,
  browserPaneSetMessage,
} from "./browser-pane";
import { browserPaneExtensionPath, writeBrowserPaneExtension } from "./browser-pane-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-browser-pane-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const URL_A = `http://127.0.0.1:4242/${"A".repeat(43)}`;
const URL_B = `http://127.0.0.1:4243/${"B".repeat(43)}`;

/** The `set <json>` argument string the spawner's hidden message carries. */
function setArgs(url: string): string {
  return browserPaneSetMessage(url).slice(`/${BROWSER_PANE_COMMAND} `.length);
}

// ------------------------------------------------------------------ fixtures

interface Sent {
  msg: { customType: string; content: string; display: boolean; attribution: string };
  opts: { deliverAs: string; triggerTurn: boolean };
}

interface Session {
  isStreaming: boolean;
  /** Set to make the next sendCustomMessage reject once. */
  rejectNext: boolean;
  prompt(text: string): Promise<void>;
}

interface Harness {
  AgentSession: new () => Session;
  invoke(args: string): Promise<void>;
  fire(event: string): Promise<void>;
  sent: Sent[];
  notices: { message: string; level: string | undefined }[];
}

/** Transpiles the generated file and instantiates it against a fake omp surface. */
function harness(opts: { canSendMessages?: boolean } = {}): Harness {
  const file = writeBrowserPaneExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated browser pane extension has no default factory");

  const sent: Sent[] = [];
  const notices: Harness["notices"] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  class FakeAgentSession implements Session {
    isStreaming = false;
    rejectNext = false;
    async prompt(): Promise<void> {}
  }
  if (opts.canSendMessages !== false) {
    Object.defineProperty(FakeAgentSession.prototype, "sendCustomMessage", {
      value: async function (this: FakeAgentSession, msg: Sent["msg"], opts: Sent["opts"]): Promise<void> {
        if (this.rejectNext) {
          this.rejectNext = false;
          throw new Error("session closed");
        }
        sent.push({ msg, opts });
      },
    });
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(BROWSER_PANE_COMMAND);
      handler = options.handler;
    },
    on: (event: string, fn: (...args: unknown[]) => void): void => {
      (listeners[event] ??= []).push(fn);
    },
  });

  const ctx = {
    ui: {
      notify: (message: string, level?: string): void => {
        notices.push({ message, level });
      },
    },
  };

  return {
    AgentSession: FakeAgentSession,
    invoke: async (args) => {
      if (!handler) throw new Error("generated extension registered no command");
      await handler(args, ctx);
    },
    fire: async (event) => {
      for (const fn of listeners[event] ?? []) fn();
      // The event path chains deliver() without awaiting it.
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
    sent,
    notices,
  };
}

/** Binds a root by prompting — omp dispatches the arming slash command through prompt. */
async function bound(h: Harness): Promise<Session> {
  const root = new h.AgentSession();
  await root.prompt("hello");
  return root;
}

// ------------------------------------------------------------------- tests

describe("writeBrowserPaneExtension", () => {
  it("writes into the lineage dir, overwrites a stale copy, and strictly typechecks", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeBrowserPaneExtension(lineage);
    expect(file).toBe(browserPaneExtensionPath(lineage));
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeBrowserPaneExtension(lineage);
    typecheckGeneratedExtension(file);
  });
});

describe("endpoint delivery", () => {
  it("delivers one hidden message to the root for the next turn when idle", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(1);
    const [{ msg, opts }] = h.sent;
    expect(msg).toEqual({
      customType: BROWSER_PANE_CUSTOM_TYPE,
      content: browserPaneInstruction(URL_A),
      display: false,
      attribution: "agent",
    });
    expect(opts).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
    expect(h.notices).toEqual([]);
  });

  it("steers a streaming root instead of waiting for the next turn", async () => {
    const h = harness();
    const root = await bound(h);
    root.isStreaming = true;
    await h.invoke(setArgs(URL_A));
    expect(h.sent.map((s) => s.opts.deliverAs)).toEqual(["steer"]);
  });

  it("binds the first prompting session as the root and never retargets", async () => {
    const h = harness();
    const root = await bound(h);
    const other = new h.AgentSession();
    await other.prompt("child");
    other.isStreaming = true;
    root.isStreaming = false;
    await h.invoke(setArgs(URL_A));
    // Delivered through the root: its idle state picked nextTurn, not the child's steer.
    expect(h.sent.map((s) => s.opts.deliverAs)).toEqual(["nextTurn"]);
  });

  it("skips a repeated endpoint and delivers a changed one", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(URL_A));
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(1);
    await h.invoke(setArgs(URL_B));
    expect(h.sent.map((s) => s.msg.content)).toEqual([
      browserPaneInstruction(URL_A),
      browserPaneInstruction(URL_B),
    ]);
  });

  it("clear sends nothing and leaves the delivered endpoint remembered", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(URL_A));
    await h.invoke("clear");
    expect(h.sent).toHaveLength(1);
    // The agent still holds URL_A in its context, so arming it again is a no-op...
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(1);
    // ...until a context rebuild forgets it. With the endpoint cleared, the
    // rebuild itself delivers nothing; the next set does.
    await h.invoke("clear");
    await h.fire("session_compact");
    expect(h.sent).toHaveLength(1);
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(2);
  });

  it.each(["session_compact", "session_branch", "session_switch"])(
    "re-delivers the armed endpoint after %s",
    async (event) => {
      const h = harness();
      await bound(h);
      await h.invoke(setArgs(URL_A));
      await h.fire(event);
      expect(h.sent.map((s) => s.msg.content)).toEqual([
        browserPaneInstruction(URL_A),
        browserPaneInstruction(URL_A),
      ]);
    },
  );

  it("retries the same endpoint after a rejected delivery", async () => {
    const h = harness();
    const root = await bound(h);
    root.rejectNext = true;
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(0);
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });
});

describe("refusals", () => {
  it.each([
    ["bad JSON", "set {cdpUrl:"],
    ["an extra key", `set ${JSON.stringify({ cdpUrl: URL_A, extra: true })}`],
    ["a non-loopback host", `set ${JSON.stringify({ cdpUrl: `http://10.0.0.5:4242/${"A".repeat(43)}` })}`],
    ["an unknown verb", "arm"],
  ])("warns and sends nothing for %s", async (_label, args) => {
    const h = harness();
    await bound(h);
    await h.invoke(args);
    expect(h.sent).toEqual([]);
    expect(h.notices.map((n) => n.level)).toEqual(["warning"]);
    // A later valid set is unaffected.
    await h.invoke(setArgs(URL_A));
    expect(h.sent).toHaveLength(1);
  });

  it("warns once per process when the root cannot carry custom messages", async () => {
    const h = harness({ canSendMessages: false });
    await bound(h);
    await h.invoke(setArgs(URL_A));
    await h.invoke(setArgs(URL_B));
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
    expect(h.notices.map((n) => n.level)).toEqual(["warning"]);
  });
});
