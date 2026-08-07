import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { PLAN_COMMAND, PLAN_REVIEW_SENTINEL, PLAN_STATUS_KEY } from "./plan";
import { planExtensionPath, writePlanExtension } from "./plan-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-plan-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writePlanExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writePlanExtension(lineage);
    expect(file).toBe(planExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("emits the wire constants both sides agree on", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // A drifted constant would silently strand the renderer's routing.
    expect(source).toContain(JSON.stringify(PLAN_STATUS_KEY));
    expect(source).toContain(JSON.stringify(PLAN_REVIEW_SENTINEL));
    expect(source).toContain(JSON.stringify(PLAN_COMMAND));
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writePlanExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writePlanExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(PLAN_STATUS_KEY));
  });

  it("keeps the read-only guarantee's approval path in the generated source", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // Approval must go through omp's own validation, and exiting plan mode is
    // what restores write access — neither may be optimized away.
    expect(source).toContain("preparePlanForReview");
    expect(source).toContain("setPlanReferencePath");
    expect(source).toContain("setPlanProposalHandler");
  });

  it("arms the read-only guard by wrapping getPlanModeState, not by setting plan state", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // omp's write guard reads the public getPlanModeState, but its per-turn
    // plan-authoring mandate reads a private field, so the two cannot be
    // separated through setPlanModeState. The mode is entered by wrapping the
    // getter and delivering omp-ui's own instruction instead (ADR-0013).
    expect(source).toContain("getPlanModeState = function");
    expect(source).toContain("read-only, enforced by omp's own plan-mode write guard");
    // omp's per-turn planning mandate creeping back is the regression that
    // matters: it would force a plan on every turn again.
    expect(source).not.toContain("sendPlanModeContext");
  });

  it("carries the html rendition contract into the generated source", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // The renderer sends the format as the command's second token, the
    // instruction rides a hidden custom message, and the review request names
    // the companion file derived from the canonical markdown plan.
    expect(source).toContain('tokens[1] === "html"');
    expect(source).toContain("sendCustomMessage");
    expect(source).toContain('replace(/\\.md$/, ".html")');
    expect(source).toContain("planHtmlAbsPath");
    expect(source).toContain("local://<slug>-plan.html");
  });

  it("keeps markdown canonical, so omp's own plan gate still has its artifact", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // omp hardcodes -plan.md through its propose gate and write guard: the
    // instruction must never offer the html file as a replacement.
    expect(source).toContain("local://<slug>-plan.md (still required");
    expect(source).toContain('let format: "html" | "md" = "md"');
  });

  it("writes a syntactically valid TS extension omp can transpile", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    const errors = (diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((e) => String(e.messageText))).toEqual([]);
  });
});

/** The fake AgentSession's record of one hidden custom message. */
interface SentMessage {
  customType: string;
  content: string;
  deliverAs: string;
}

interface PlanUi {
  setStatus: (key: string, text: string | undefined) => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  notify: (message: string, level?: string) => void;
}

interface ExtensionApi {
  pi: { AgentSession: { prototype: Record<string, unknown> } };
  registerCommand: (
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: { ui: PlanUi }) => Promise<void>;
    },
  ) => void;
}

type ExtensionFactory = (api: ExtensionApi) => void;

/**
 * The extension is delivered as generated source, so the only honest test is to
 * transpile what `writePlanExtension` wrote and run it. Its whole state lives
 * inside the default export, so each harness gets its own instance — and its own
 * session class, because the extension patches the prototype.
 */
async function loadExtension(): Promise<ExtensionFactory> {
  const file = writePlanExtension(tempLineage());
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const js = file.replace(/\.ts$/, ".mjs");
  fs.writeFileSync(js, outputText, "utf8");
  const mod: unknown = await import(pathToFileURL(js).href);
  if (!mod || typeof mod !== "object" || !("default" in mod) || typeof mod.default !== "function") {
    throw new Error("generated extension has no default export");
  }
  // The generated module is ours; its default export is the extension factory.
  return mod.default as ExtensionFactory;
}

interface Harness {
  run: (args: string) => Promise<void>;
  /** Fire without awaiting, to interleave two transitions. */
  dispatch: (args: string) => Promise<void>;
  status: () => { enabled: boolean } | null;
  /** What omp's write guard sees. */
  guardArmed: () => boolean;
  sent: SentMessage[];
  tools: () => string[];
  notices: string[];
}

function harness(
  factory: ExtensionFactory,
  options?: { canSendMessages?: boolean },
): Harness {
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  let tools = ["read", "grep", "write"];
  let planState: { enabled: boolean } | undefined;

  // A fresh class per harness: the extension patches prototype methods.
  class FakeSession {
    isStreaming = false;
    sessionManager = {
      getArtifactsDir: () => "/tmp/omp-ui-fake-artifacts",
      appendModeChange: () => undefined,
    };
    getPlanModeState(): { enabled: boolean } | undefined {
      return planState;
    }
    setPlanModeState(state: { enabled: boolean } | undefined): void {
      planState = state;
    }
    getPlanReferencePath(): string {
      return "";
    }
    setPlanReferencePath(): void {}
    setPlanProposalHandler(): void {}
    async preparePlanForReview(title: string) {
      return { content: [{ type: "text", text: title }] };
    }
    async setActiveToolsByName(names: string[]): Promise<void> {
      // Await first: this is the yield the swallowed-toggle race needs (#118).
      await Promise.resolve();
      tools = [...names];
    }
    getEnabledToolNames(): string[] {
      return [...tools];
    }
    hasBuiltInTool(): boolean {
      return true;
    }
    prompt(): Promise<boolean> {
      return Promise.resolve(true);
    }
  }
  if (options?.canSendMessages !== false) {
    Object.defineProperty(FakeSession.prototype, "sendCustomMessage", {
      value: async function (
        msg: { customType: string; content: string },
        opts: { deliverAs: string },
      ) {
        sent.push({ customType: msg.customType, content: msg.content, deliverAs: opts.deliverAs });
        return false;
      },
      writable: true,
      configurable: true,
    });
  }

  let handler: ((args: string, ctx: { ui: PlanUi }) => Promise<void>) | undefined;
  let statusText: string | undefined;
  const ui: PlanUi = {
    setStatus: (_key, text) => {
      statusText = text;
    },
    select: async () => undefined,
    notify: (message) => {
      notices.push(message);
    },
  };

  factory({
    pi: { AgentSession: { prototype: FakeSession.prototype as unknown as Record<string, unknown> } },
    registerCommand: (_name, opts) => {
      handler = opts.handler;
    },
  });

  const session = new FakeSession();
  // The extension captures the session off prompt; omp dispatches slash commands
  // from inside prompt, so this is what a real toggle does first.
  void session.prompt();

  const dispatch = (args: string): Promise<void> => {
    if (!handler) throw new Error("the extension registered no command");
    return handler(args, { ui });
  };

  return {
    run: dispatch,
    dispatch,
    status: () => (statusText === undefined ? null : JSON.parse(statusText)),
    guardArmed: () => session.getPlanModeState()?.enabled === true,
    sent,
    tools: () => [...tools],
    notices,
  };
}

const entries = (sent: SentMessage[]) => sent.filter((m) => m.customType === "omp-ui:plan-mode");
const exits = (sent: SentMessage[]) => sent.filter((m) => m.customType === "omp-ui:plan-mode-exit");

describe("plan mode transitions", () => {
  it("tells the agent the mode ended, because exiting is otherwise invisible", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");
    await h.run("off");

    const last = h.sent.at(-1);
    expect(last?.customType).toBe("omp-ui:plan-mode-exit");
    expect(last?.content).toContain("Plan mode is OFF");
    // The stacked entry instructions cannot be deleted, so the retraction has to
    // supersede them by name.
    expect(last?.content).toContain("plan-format");
    expect(h.status()?.enabled).toBe(false);
    expect(h.guardArmed()).toBe(false);
  });

  it("retracts once per entry, so re-entering cannot stack an unanswered mode", async () => {
    const h = harness(await loadExtension());
    for (const args of ["on html", "off", "on html", "off"]) await h.run(args);

    expect(entries(h.sent)).toHaveLength(2);
    expect(exits(h.sent)).toHaveLength(2);
    // Issue #117: the second exit is the failure the user saw.
    expect(h.sent.at(-1)?.customType).toBe("omp-ui:plan-mode-exit");
  });

  it("makes every entry supersede the instructions still in the conversation", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");

    expect(entries(h.sent)[0]?.content).toContain("supersedes every earlier omp-ui");
  });

  it("never tells a session it left a mode it was never told it entered", async () => {
    const h = harness(await loadExtension());
    await h.run("off");
    expect(h.sent).toHaveLength(0);

    // An omp that cannot carry hidden instructions still arms the guard, and
    // exiting it must stay silent rather than warn twice.
    const mute = harness(await loadExtension(), { canSendMessages: false });
    await mute.run("on html");
    expect(mute.guardArmed()).toBe(true);
    await mute.run("off");
    expect(mute.guardArmed()).toBe(false);
    expect(mute.status()?.enabled).toBe(false);
  });

  it("applies interleaved toggles in arrival order", async () => {
    const h = harness(await loadExtension());
    // Issue #118: dispatched together, the off used to be swallowed by the on.
    const on = h.dispatch("on html");
    const off = h.dispatch("off");
    await on;
    await off;

    expect(h.status()?.enabled).toBe(false);
    expect(h.guardArmed()).toBe(false);
    expect(h.tools()).toEqual(["read", "grep", "write"]);
    expect(exits(h.sent)).toHaveLength(1);
  });
});
