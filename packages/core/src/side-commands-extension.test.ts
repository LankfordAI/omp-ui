import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SIDE_COMMANDS_COMMAND,
  SIDE_COMMANDS_RENDER_ARG_PREFIX,
  SIDE_COMMANDS_STATUS_BYTE_LIMIT,
  SIDE_COMMANDS_STATUS_KEY,
  parseSideCommandsSnapshot,
  sideCommandRenderMessage,
  type SideCommandRenderRequest,
  type SideCommandsSnapshot,
} from "./side-commands";
import { BTW_QUESTION_CHAR_LIMIT } from "./side-questions";
import { sideCommandsExtensionPath, writeSideCommandsExtension } from "./side-commands-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-side-commands-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

/** The literal specifier the generated bridge imports (ADR-0036). */
const SLASH_COMMANDS_MODULE = "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";

type RenderFn = (command: unknown, args: string) => unknown;

interface Session {
  slashCommands: unknown;
  prompts: string[];
  prompt(text: string): Promise<boolean>;
}

interface Harness {
  AgentSession: new (slashCommands: unknown) => Session;
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  render: (request: SideCommandRenderRequest) => Promise<void>;
  snapshot: () => SideCommandsSnapshot;
  statuses: SideCommandsSnapshot[];
  /** Every renderFileSlashCommand call the bridge made, verbatim. */
  renderCalls: Array<{ command: unknown; args: string }>;
}

interface HarnessOptions {
  /** omp's renderFileSlashCommand; defaults to echoing the args into a question. */
  render?: RenderFn;
  /** False: the literal specifier does not resolve in this module space. */
  module?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const file = writeSideCommandsExtension(tempLineage());
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const renderCalls: Harness["renderCalls"] = [];
  const render = options.render ?? ((_command: unknown, args: string): unknown => "Sitrep about " + args);
  // CommonJS output lowers the bridge's literal import() to require(), so
  // this fake is the whole module space the bridge can see.
  const fakeRequire = (specifier: string): unknown => {
    if (options.module === false) {
      throw new Error("Cannot find package '@oh-my-pi/pi-coding-agent' from " + specifier);
    }
    if (specifier === SLASH_COMMANDS_MODULE) {
      return {
        renderFileSlashCommand: (command: unknown, args: string): unknown => {
          renderCalls.push({ command, args });
          return render(command, args);
        },
      };
    }
    throw new Error("generated bridge required an unowned module: " + specifier);
  };
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, fakeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated side-commands extension has no default factory");

  const statuses: SideCommandsSnapshot[] = [];
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;

  class FakeAgentSession {
    slashCommands: unknown;
    prompts: string[] = [];

    constructor(slashCommands: unknown) {
      this.slashCommands = slashCommands;
    }

    prompt(text: string): Promise<boolean> {
      this.prompts.push(text);
      return Promise.resolve(true);
    }
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, registered: { handler: typeof handler }): void => {
      expect(name).toBe(SIDE_COMMANDS_COMMAND);
      handler = registered.handler;
    },
  });

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated extension registered no command");
    await handler(args, {
      ui: {
        setStatus: (key: string, text: string | undefined): void => {
          expect(key).toBe(SIDE_COMMANDS_STATUS_KEY);
          const snapshot = parseSideCommandsSnapshot(text);
          if (snapshot === null) throw new Error("published a snapshot the shared wire parser rejects: " + text);
          statuses.push(snapshot);
        },
      },
    });
  };

  return {
    AgentSession: FakeAgentSession as unknown as Harness["AgentSession"],
    invoke,
    arm: () => invoke(""),
    // omp hands the handler everything after the command name.
    render: (request) => invoke(sideCommandRenderMessage(request).slice(`/${SIDE_COMMANDS_COMMAND} `.length)),
    snapshot: (): SideCommandsSnapshot => {
      const value = statuses.at(-1);
      if (!value) throw new Error("the bridge published no snapshot");
      return value;
    },
    statuses,
    renderCalls,
  };
}

/** Binds a root by prompting, as omp's first dispatched prompt does. */
async function bound(h: Harness, slashCommands: unknown): Promise<Session> {
  const root = new h.AgentSession(slashCommands);
  await root.prompt("hello");
  return root;
}

const SITREP = { name: "sitrep", side: true, content: "Give a sitrep about $ARGUMENTS" };
const PLAIN = { name: "plain", content: "Say $ARGUMENTS" };

// ------------------------------------------------------------------- tests

describe("writeSideCommandsExtension", () => {
  it("writes the bridge into the lineage dir and is rewritten on every spawn", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeSideCommandsExtension(lineage);
    expect(file).toBe(sideCommandsExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeSideCommandsExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(SIDE_COMMANDS_STATUS_KEY));
  });

  it("emits a generated source that strictly typechecks and carries the wire contract", () => {
    const file = writeSideCommandsExtension(tempLineage());
    typecheckGeneratedExtension(file);
    const source = fs.readFileSync(file, "utf8");
    for (const constant of [SIDE_COMMANDS_COMMAND, SIDE_COMMANDS_STATUS_KEY, SIDE_COMMANDS_RENDER_ARG_PREFIX]) {
      expect(source).toContain(JSON.stringify(constant));
    }
    expect(source).toContain(String(SIDE_COMMANDS_STATUS_BYTE_LIMIT));
    expect(source).toContain(String(BTW_QUESTION_CHAR_LIMIT));
    expect(source).toContain(JSON.stringify(SLASH_COMMANDS_MODULE));
  });
});

describe("side-commands bridge arm", () => {
  it("publishes only the root's side: true file commands, deduped and sorted", async () => {
    const h = harness();
    const root = await bound(h, [
      { name: "zeta", side: true },
      PLAIN,
      { name: "alpha", side: true },
      { name: "stringly", side: "true" },
      { name: "", side: true },
      { side: true },
      null,
      ["array", true],
      { name: "alpha", side: true },
    ]);
    await h.arm();
    const snapshot = h.snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.processKey).not.toBe("");
    expect(snapshot.available).toBe(true);
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.commands).toEqual(["alpha", "zeta"]);
    expect(snapshot.result).toBeNull();
    // The wrapper calls through unchanged.
    expect(root.prompts).toEqual(["hello"]);
    expect(h.renderCalls).toEqual([]);
  });

  it("reports no-session before any prompt binds a root", async () => {
    const h = harness();
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "no-session", commands: [] });
  });

  it("reports missing-api when the root's command list is unreadable", async () => {
    const h = harness();
    await bound(h, "not a list");
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "missing-api", commands: [] });
  });

  it("binds the root once and never reads a descendant session's commands", async () => {
    const h = harness();
    await bound(h, [SITREP]);
    const descendant = new h.AgentSession([{ name: "child-only", side: true }]);
    await descendant.prompt("subagent work");
    await h.arm();
    expect(h.snapshot().commands).toEqual(["sitrep"]);
  });

  it("reports missing-api when the slash-commands module does not resolve", async () => {
    const h = harness({ module: false });
    await bound(h, [SITREP]);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "missing-api", commands: [] });
    await h.render({ requestId: "r1", name: "sitrep", args: "" });
    expect(h.snapshot().result).toEqual({
      requestId: "r1",
      ok: false,
      reason: "render-failed",
      message: "omp cannot expand slash commands in this session",
    });
  });

  it("degrades an oversized side set to payload-too-large", async () => {
    const h = harness();
    const commands = Array.from({ length: 300 }, (_, i) => ({ name: "c" + i + "-" + "x".repeat(1000), side: true }));
    await bound(h, commands);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "payload-too-large", commands: [] });
    // A rendered question that would ride the oversized payload is refused, not truncated.
    await h.render({ requestId: "big", name: commands[0]!.name, args: "now" });
    expect(h.snapshot().result).toEqual({ requestId: "big", ok: false, reason: "too-long", message: null });
  });

  it("increases the revision on every publish and retains the last result", async () => {
    const h = harness();
    await bound(h, [SITREP]);
    await h.arm();
    await h.render({ requestId: "r1", name: "sitrep", args: "x" });
    await h.arm();
    expect(h.statuses.map((s) => s.revision)).toEqual([1, 2, 3]);
    expect(h.statuses[2]!.result).toEqual(h.statuses[1]!.result);
    expect(new Set(h.statuses.map((s) => s.processKey)).size).toBe(1);
  });
});

describe("side-commands bridge render", () => {
  it("renders through omp's renderFileSlashCommand with the args verbatim", async () => {
    const h = harness();
    const entry = { ...SITREP };
    await bound(h, [PLAIN, entry]);
    const args = ' alpha  "beta gamma"\t';
    await h.render({ requestId: "r1", name: "sitrep", args });
    expect(h.renderCalls).toHaveLength(1);
    expect(h.renderCalls[0]!.command).toBe(entry);
    expect(h.renderCalls[0]!.args).toBe(args);
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.commands).toEqual(["sitrep"]);
    expect(snapshot.result).toEqual({ requestId: "r1", ok: true, question: "Sitrep about " + args });
  });

  it("answers not-side for a command without side: true or an unknown name", async () => {
    const h = harness();
    await bound(h, [SITREP, PLAIN]);
    await h.render({ requestId: "r-plain", name: "plain", args: "" });
    expect(h.snapshot().result).toEqual({ requestId: "r-plain", ok: false, reason: "not-side", message: null });
    await h.render({ requestId: "r-gone", name: "gone", args: "" });
    expect(h.snapshot().result).toEqual({ requestId: "r-gone", ok: false, reason: "not-side", message: null });
    expect(h.renderCalls).toEqual([]);
  });

  it("answers render-failed with the renderer's message when it throws", async () => {
    const h = harness({
      render: () => {
        throw new Error("Handlebars parse error on line 1");
      },
    });
    await bound(h, [SITREP]);
    await h.render({ requestId: "r1", name: "sitrep", args: "x" });
    expect(h.snapshot().result).toEqual({
      requestId: "r1",
      ok: false,
      reason: "render-failed",
      message: "Handlebars parse error on line 1",
    });
  });

  it("caps a thrown renderer message at 1000 characters", async () => {
    const h = harness({
      render: () => {
        throw new Error("e".repeat(5000));
      },
    });
    await bound(h, [SITREP]);
    await h.render({ requestId: "r1", name: "sitrep", args: "x" });
    const result = h.snapshot().result;
    expect(result?.ok).toBe(false);
    expect(result !== null && !result.ok ? result.message : null).toBe("e".repeat(1000));
  });

  it("answers render-failed when the renderer returns no text", async () => {
    const h = harness({ render: () => undefined });
    await bound(h, [SITREP]);
    await h.render({ requestId: "r1", name: "sitrep", args: "x" });
    expect(h.snapshot().result).toEqual({
      requestId: "r1",
      ok: false,
      reason: "render-failed",
      message: "the command rendered no text",
    });
  });

  it("answers empty for a whitespace-only render", async () => {
    const h = harness({ render: () => " \n\t " });
    await bound(h, [SITREP]);
    await h.render({ requestId: "r1", name: "sitrep", args: "" });
    expect(h.snapshot().result).toEqual({ requestId: "r1", ok: false, reason: "empty", message: null });
  });

  it("answers too-long past the side-question limit and accepts the limit itself", async () => {
    const h = harness({ render: (_command, args) => "q".repeat(Number(args)) });
    await bound(h, [SITREP]);
    await h.render({ requestId: "over", name: "sitrep", args: String(BTW_QUESTION_CHAR_LIMIT + 1) });
    expect(h.snapshot().result).toEqual({ requestId: "over", ok: false, reason: "too-long", message: null });
    await h.render({ requestId: "at", name: "sitrep", args: String(BTW_QUESTION_CHAR_LIMIT) });
    expect(h.snapshot().result).toEqual({ requestId: "at", ok: true, question: "q".repeat(BTW_QUESTION_CHAR_LIMIT) });
  });

  it("throws from the handler on a malformed render request and publishes nothing", async () => {
    const h = harness();
    await bound(h, [SITREP]);
    const malformed = [
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "r1", name: "sitrep", args: "", extra: 1 }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "r1", name: "sitrep" }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "", name: "sitrep", args: "" }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "r".repeat(129), name: "sitrep", args: "" }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "r1", name: "", args: "" }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + JSON.stringify({ requestId: "r1", name: "sitrep", args: 1 }),
      SIDE_COMMANDS_RENDER_ARG_PREFIX + "{not json",
    ];
    for (const args of malformed) {
      await expect(h.invoke(args), args).rejects.toThrow("malformed render request");
    }
    await expect(h.invoke("refresh")).rejects.toThrow("unsupported command args");
    expect(h.statuses).toEqual([]);
    expect(h.renderCalls).toEqual([]);
  });
});
