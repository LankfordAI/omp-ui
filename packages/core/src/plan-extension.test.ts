import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_COMMAND,
  PLAN_REVIEW_SENTINEL,
  PLAN_STATUS_KEY,
  type PlanReviewRequest,
} from "./plan";
import { planExtensionPath, writePlanExtension } from "./plan-extension";

const dirs: string[] = [];

const nodeRequire = createRequire(import.meta.url);

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

  it("carries the direct-html plan contract into the generated source", async () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // The renderer sends the plan format as the command's second token, the
    // hidden instruction names the single file the agent writes, and the
    // extension resolves that artifact itself instead of deriving a companion
    // rendition from a markdown plan.
    expect(source).toContain('tokens[1] === "html"');
    expect(source).toContain("sendCustomMessage");
    expect(source).toContain("local://<slug>-plan.html");
    expect(source).toContain("resolveHtmlPlan");
    // The language-class contract (issue #319): the grammar list must stay in
    // lockstep with the renderer's curated LANG_IMPORTS/ALIASES tables.
    expect(source).toContain("language-");
    expect(source).toContain("bash, c, cpp");
    expect(source).not.toContain("planHtmlAbsPath");

    const h = harness(await loadExtension());
    await h.run("on html");
    const instruction = entries(h.sent)[0]?.content ?? "";
    expect(instruction).toContain(
      "paints the page canvas and the reading ink from the active omp-ui theme",
    );
    expect(instruction).toContain("WCAG AA contrast of at least 4.5:1");
    expect(instruction).toContain("never set a node `color:`");
    expect(instruction).toContain("fit any iframe with no horizontal page scrolling");
    expect(instruction).toContain("viewport meta tag");
    expect(instruction).toContain("border-box sizing");
    expect(instruction).toContain("fluid widths capped by max-width");
    expect(instruction).toContain("wrap long code and paths");
    expect(instruction).toContain("fit tables within the viewport without overflow");
    expect(instruction).toContain("may overlap or clip");
    expect(instruction).toContain("Choose the diagram tool by what the figure represents");
    expect(instruction).toContain('<pre class="mermaid">');
    expect(instruction).toContain("mermaid source");
    expect(instruction).toContain("error callout");
    expect(instruction).toContain("classDef");
    expect(instruction).toContain("classDef for groups and style for one-offs");
    // Spatial figures may be hand-drawn, but only with the layout recipe that
    // prevents the overlap/clipping that made us ban freehand SVG (#287).
    // Direction is a deliberate choice, not a TD default (#289): LR for
    // pipelines/timelines, BT for funnels, organic flows go to hand-drawn SVG.
    expect(instruction).toContain("flowchart LR");
    expect(instruction).toContain("flowchart BT");
    expect(instruction).toContain("Do not default every chart to a tall TD stack");
    expect(instruction).toContain("Hand-drawn inline SVG is the right tool");
    expect(instruction).toContain("never straddling an edge");
    expect(instruction).toContain("0.6 times font-size");
    expect(instruction).toContain("coarse grid");
  });

  it("never quietly reverts to asking the agent for both plan files", () => {
    const source = fs.readFileSync(writePlanExtension(tempLineage()), "utf8");
    // The two-file era is what this replaced: an html plan mode that also asks
    // for a canonical markdown plan leaves two plans to disagree, so the
    // instruction has to forbid the markdown one outright.
    expect(source).toContain("Write NO markdown plan");
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

/**
 * The other honest route to the generated extension — transpile to CommonJS and
 * run it through `Function`, exactly as the capabilities suite does — used by the
 * tool-ownership tests so one factory instance drives exactly one fake runtime
 * class. The generated source imports only node builtins, so node's own require
 * is the whole module system it needs.
 */
function executableExtension(): ExtensionFactory {
  const file = writePlanExtension(tempLineage());
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: ExtensionFactory } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, nodeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");
  return factory;
}

/** What omp's `xd://propose` gate hands back to the model. */
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: { planFilePath?: string; title?: string };
  isError?: boolean;
}

/**
 * omp's own plan-title sanitizer, mirrored so the fake markdown resolver names
 * its artifact exactly the way omp's `resolveApprovedPlan` would.
 */
function slugForPlanFile(title: string): string {
  return title
    .trim()
    .replace(/\.md$/i, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface Harness {
  run: (args: string) => Promise<void>;
  /** Fire without awaiting, to interleave two transitions. */
  dispatch: (args: string) => Promise<void>;
  /** Drive omp's propose gate through the handler the extension installed. */
  propose: (title: string) => Promise<ToolResult>;
  /** The plan review request the extension packed behind the sentinel. */
  reviewed: () => PlanReviewRequest | null;
  status: () => { enabled: boolean } | null;
  /** What omp's write guard sees. */
  guardArmed: () => boolean;
  /** The path pinned as the session's plan reference when the user executes. */
  referencePath: () => string | null;
  /** Titles omp's own markdown plan resolver was asked to resolve. */
  prepared: string[];
  /** Titles handed to `ui.select`. */
  selects: string[];
  /** Choose what the next `ui.select` answers with. */
  answer: (value: string | undefined) => void;
  sent: SentMessage[];
  tools: () => string[];
  notices: string[];
}

function harness(
  factory: ExtensionFactory,
  options?: { canSendMessages?: boolean; artifactsDir?: string | null; markdownPlan?: boolean },
): Harness {
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  const prepared: string[] = [];
  const selects: string[] = [];
  let tools = ["read", "grep", "write"];
  let planState: { enabled: boolean } | undefined;
  let proposalHandler: ((title: string) => Promise<ToolResult>) | undefined;
  let referencePath: string | null = null;
  let answer: string | undefined;

  // A fresh class per harness: the extension patches prototype methods.
  class FakeSession {
    isStreaming = false;
    sessionManager = {
      // An explicit `null` must survive: that is the omp that cannot host html plans.
      getArtifactsDir: () =>
        options?.artifactsDir !== undefined ? options.artifactsDir : "/tmp/omp-ui-fake-artifacts",
      appendModeChange: () => undefined,
    };
    getPlanModeState(): { enabled: boolean } | undefined {
      return planState;
    }
    setPlanModeState(state: { enabled: boolean } | undefined): void {
      planState = state;
    }
    getPlanReferencePath(): string {
      return referencePath ?? "";
    }
    setPlanReferencePath(pathValue: string): void {
      referencePath = pathValue;
    }
    setPlanProposalHandler(h: ((title: string) => Promise<ToolResult>) | null): void {
      proposalHandler = h ?? undefined;
    }
    async preparePlanForReview(title: string): Promise<ToolResult> {
      prepared.push(title);
      // omp's two real outcomes: it throws unless a markdown plan is on disk.
      if (options?.markdownPlan !== true) throw new Error("Plan file not found");
      return {
        content: [],
        details: { planFilePath: `local://${slugForPlanFile(title)}-plan.md`, title },
      };
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
    select: async (title) => {
      selects.push(title);
      return answer;
    },
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
    propose: (title) => {
      if (!proposalHandler) throw new Error("no proposal handler installed");
      return proposalHandler(title);
    },
    reviewed: () => {
      const last = selects.at(-1);
      if (last === undefined) return null;
      const start = last.indexOf(PLAN_REVIEW_SENTINEL) + PLAN_REVIEW_SENTINEL.length;
      return JSON.parse(last.slice(start));
    },
    status: () => (statusText === undefined ? null : JSON.parse(statusText)),
    guardArmed: () => session.getPlanModeState()?.enabled === true,
    referencePath: () => referencePath,
    prepared,
    selects,
    answer: (value) => {
      answer = value;
    },
    sent,
    tools: () => [...tools],
    notices,
  };
}

const entries = (sent: SentMessage[]) => sent.filter((m) => m.customType === "omp-ui:plan-mode");
const exits = (sent: SentMessage[]) => sent.filter((m) => m.customType === "omp-ui:plan-mode-exit");

/** The extension scans `<artifactsDir>/local` through its own node:fs, so it gets real files. */
function tempArtifacts(): string {
  const dir = tempLineage();
  fs.mkdirSync(path.join(dir, "local"), { recursive: true });
  return dir;
}

/** Explicit mtimes beat sleeping: the newest-plan fallback orders candidates by them. */
function writePlanFile(artifacts: string, name: string, mtimeSeconds: number): string {
  const file = path.join(artifacts, "local", name);
  fs.writeFileSync(file, `<!doctype html><html><body><h1>${name}</h1></body></html>`, "utf8");
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

/** The one warning a degraded html session is allowed to emit, verbatim. */
const FALLBACK_NOTICE = "HTML plans unavailable on this omp; falling back to markdown plans";

describe("html plans", () => {
  it("proposes the html plan the agent wrote", async () => {
    // Under html the agent's single file IS the plan, so nothing else may decide it.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    await h.propose("auth");

    const request = h.reviewed();
    expect(request?.planFilePath).toBe("local://auth-plan.html");
    expect(request?.planAbsPath?.endsWith(path.join("local", "auth-plan.html"))).toBe(true);
    // omp's markdown resolver would have thrown; it must never have been asked.
    expect(h.prepared).toEqual([]);
  });

  it("finds the newest html plan when the title does not reconstruct the name", async () => {
    // Propose titles drift from the filename the agent chose, so freshness decides.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    writePlanFile(artifacts, "login-plan.html", 1_700_000_600);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    await h.propose("Some Freeform Title");

    expect(h.reviewed()?.planFilePath).toBe("local://login-plan.html");
  });

  it("falls back to omp's resolver when the agent wrote markdown anyway", async () => {
    // Models ignore instructions; a markdown plan is still a plan worth reviewing.
    const h = harness(await loadExtension(), {
      artifactsDir: tempArtifacts(),
      markdownPlan: true,
    });
    await h.run("on html");
    await h.propose("auth");

    expect(h.reviewed()?.planFilePath).toBe("local://auth-plan.md");
    expect(h.prepared).toContain("auth");
  });

  it("answers an html session with no plan file at all", async () => {
    // Opening an empty review overlay would strand the user, so the model is told
    // exactly which file is missing instead.
    const h = harness(await loadExtension(), { artifactsDir: tempArtifacts() });
    await h.run("on html");
    const result = await h.propose("auth");

    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join("\n")).toContain("local://auth-plan.html");
    expect(h.selects).toEqual([]);
  });

  it("pins the html plan as the session reference on execute", async () => {
    // The implementer reads the plan back off the reference path, and only exiting
    // plan mode restores write access.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    h.answer("execute");
    await h.run("on html");
    await h.propose("auth");

    expect(h.referencePath()).toBe("local://auth-plan.html");
    expect(h.guardArmed()).toBe(false);
  });

  it("names the single html file on refine", async () => {
    // There is no companion markdown plan to revise any more; mentioning one would
    // send the agent off to write a second, disagreeing plan.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    const text = (await h.propose("auth")).content.map((c) => c.text).join("\n");

    expect(text).toContain("local://auth-plan.html");
    expect(text).not.toContain("-plan.md");
  });

  it("degrades to md when the session cannot carry hidden instructions", async () => {
    // Without sendCustomMessage the agent never learns to write html, so promising
    // an html review would deadlock the overlay.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), {
      artifactsDir: artifacts,
      canSendMessages: false,
      markdownPlan: true,
    });
    await h.run("on html");
    await h.propose("auth");

    expect(h.notices).toContain(FALLBACK_NOTICE);
    expect(h.prepared).toContain("auth");
  });

  it("degrades to md when the session has no artifacts dir", async () => {
    // No artifacts dir means no `local/` to resolve the html plan out of.
    const h = harness(await loadExtension(), { artifactsDir: null, markdownPlan: true });
    await h.run("on html");
    await h.propose("auth");

    expect(h.notices).toContain(FALLBACK_NOTICE);
    expect(h.prepared).toContain("auth");
  });

  it("md format still asks for markdown and uses omp's resolver", async () => {
    // The markdown plan format is untouched by the direct-html work.
    const h = harness(await loadExtension(), {
      artifactsDir: tempArtifacts(),
      markdownPlan: true,
    });
    await h.run("on md");

    const instruction = entries(h.sent)[0]?.content ?? "";
    expect(instruction).toContain("local://<slug>-plan.md");
    expect(instruction).not.toContain("-plan.html");

    await h.propose("auth");
    expect(h.prepared).toContain("auth");
  });
});

describe("plan mode transitions", () => {
  it("tells the agent the mode ended, because exiting is otherwise invisible", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");
    await h.run("off");

    const last = h.sent.at(-1);
    expect(last?.customType).toBe("omp-ui:plan-mode-exit");
    expect(last?.content).toContain("Build mode is ON");
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

/**
 * One roster application the extension asked omp for, and the path it took: the
 * presentation setter (with the mounted projection handed along) or the legacy
 * by-name setter.
 */
interface ApplyCall {
  via: "presentation" | "by-name";
  enabled: string[];
  mounted: string[];
  force: unknown;
}

interface RuntimeOptions {
  /** Hide setActiveToolPresentation: an omp that only takes names. */
  legacyApply?: boolean;
  /** Hide runToolRegistryMutation: an omp with no registry queue. */
  noQueue?: boolean;
  /** Hide getAllToolInfos, so the roster probe falls back to hasBuiltInTool. */
  noInfos?: boolean;
  /** Hide getMountedXdevToolNames: an omp with no xd:// surface. */
  noXdev?: boolean;
}


/**
 * A runtime that answers like the installed omp: fresh roster reads, an optional
 * re-entrant registry queue, an optional presentation setter, the busy facts as
 * plain properties — and no `setActiveToolNames`/`getActiveTools`, which the real
 * binary does not have. Every read and apply is journalled so transaction
 * ordering is proven from the log rather than assumed.
 */
function runtimeHarness(options: RuntimeOptions = {}) {
  const log: string[] = [];
  const applies: ApplyCall[] = [];
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  let handler: ((args: string, ctx: { ui: PlanUi }) => Promise<void>) | undefined;
  let statusText: string | undefined;
  let proposalHandler: ((title: string) => Promise<ToolResult>) | undefined;
  let planState: { enabled: boolean } | undefined;
  let referencePath = "";

  class RuntimeSession {
    id = "root-a";
    enabled = ["read", "grep", "bash", "write", "xd://read"];
    mounted = ["xd://read", "xd://propose"];
    roster = ["read", "grep", "bash", "write", "xd://read", "xd://propose"];
    isStreaming = false;
    isAborting = false;
    queuedMessageCount = 0;
    /** Set to make every apply reject: omp refusing the registry write. */
    applyError: unknown = null;
    /** Set to hold an apply open while it still owns the queue lock. */
    applyHold: Promise<void> | null = null;
    /** Transactions currently inside omp's registry queue. */
    queueLocks = 0;
    /** Set to make the queue take the lock and never invoke the callback. */
    queueSwallowsWork = false;
    sessionManager = {
      getArtifactsDir: () => "/tmp/omp-ui-fake-artifacts",
      appendModeChange: (mode: string): void => {
        log.push("mode:" + mode);
      },
      getSessionId: (): string => this.id,
    };
    getMountedXdevToolNames?: () => string[];
    getAllToolInfos?: () => Record<string, unknown>[];
    hasBuiltInTool?: (name: string) => boolean;
    setActiveToolPresentation?: (enabled: string[], mounted: string[], force?: boolean) => Promise<void>;
    setActiveToolsByName?: (names: string[]) => Promise<void>;
    runToolRegistryMutation?: (work: () => Promise<unknown>) => Promise<unknown>;
    private queueTail: Promise<void> = Promise.resolve();

    constructor(id?: string) {
      if (id !== undefined) this.id = id;
      if (!options.noXdev) {
        this.getMountedXdevToolNames = (): string[] => {
          log.push("read:mounted");
          return [...this.mounted];
        };
      }
      if (options.noInfos) this.hasBuiltInTool = (name: string): boolean => this.roster.includes(name);
      else {
        this.getAllToolInfos = (): Record<string, unknown>[] => {
          log.push("read:roster");
          return this.roster.map((name) => ({ name, source: "builtin" }));
        };
      }
      if (options.legacyApply) {
        this.setActiveToolsByName = async (names: string[]): Promise<void> => {
          log.push("apply:by-name");
          applies.push({ via: "by-name", enabled: [...names], mounted: [], force: undefined });
          if (this.applyError !== null) throw this.applyError;
          if (this.applyHold !== null) await this.applyHold;
          this.enabled = [...names];
        };
      } else {
        this.setActiveToolPresentation = async (
          enabled: string[],
          mounted: string[],
          force?: boolean,
        ): Promise<void> => {
          log.push("apply:presentation");
          applies.push({ via: "presentation", enabled: [...enabled], mounted: [...mounted], force });
          if (this.applyError !== null) throw this.applyError;
          if (this.applyHold !== null) await this.applyHold;
          this.enabled = [...enabled];
          this.mounted = [...mounted];
        };
      }
      if (!options.noQueue) {
        this.runToolRegistryMutation = (work: () => Promise<unknown>): Promise<unknown> => {
          // A real serialized queue: whoever holds it runs to completion first.
          const run = this.queueTail.then(() => {
            log.push("queue:enter");
            if (this.queueSwallowsWork) {
              // Takes the lock and resolves without invoking the callback: the
              // omp that swallows a handler rather than running it.
              log.push("queue:exit");
              return undefined;
            }
            this.queueLocks += 1;
            return work().finally(() => {
              this.queueLocks -= 1;
              log.push("queue:exit");
            });
          });
          this.queueTail = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        };
      }
    }

    getPlanModeState(): { enabled: boolean } | undefined {
      return planState;
    }
    setPlanModeState(state: { enabled: boolean } | undefined): void {
      planState = state;
    }
    getPlanReferencePath(): string {
      return referencePath;
    }
    setPlanReferencePath(value: string): void {
      referencePath = value;
    }
    setPlanProposalHandler(h: ((title: string) => Promise<ToolResult>) | null): void {
      proposalHandler = h ?? undefined;
      log.push("handler:" + (h ? "installed" : "cleared"));
    }
    async preparePlanForReview(): Promise<ToolResult> {
      throw new Error("Plan file not found");
    }
    getEnabledToolNames(): string[] {
      log.push("read:enabled");
      return [...this.enabled];
    }
    sendCustomMessage = async (
      msg: { customType: string; content: string },
      opts: { deliverAs: string },
    ): Promise<boolean> => {
      sent.push({ customType: msg.customType, content: msg.content, deliverAs: opts.deliverAs });
      return false;
    };

    prompt(): Promise<boolean> {
      log.push("prompt:" + this.id);
      return Promise.resolve(true);
    }
  }

  const ui: PlanUi = {
    setStatus: (_key, text) => {
      statusText = text;
    },
    select: async () => undefined,
    notify: (message) => {
      notices.push(message);
    },
  };

  executableExtension()({
    pi: {
      AgentSession: { prototype: RuntimeSession.prototype as unknown as Record<string, unknown> },
    },
    registerCommand: (_name, opts) => {
      handler = opts.handler;
    },
  });

  const root = new RuntimeSession();
  // omp dispatches the slash command from inside prompt, so the root binds here
  // exactly as a real session binds it before any toggle can land.
  void root.prompt();

  return {
    root,
    log,
    applies,
    sent,
    notices,
    spawn: (id: string) => new RuntimeSession(id),
    run: async (args: string) => {
      if (!handler) throw new Error("the extension registered no command");
      await handler(args, { ui });
    },
    status: () => (statusText === undefined ? null : JSON.parse(statusText)),
    guardArmed: (session = root) => session.getPlanModeState()?.enabled === true,
    proposalInstalled: () => proposalHandler !== undefined,
    propose: async () => {
      if (!proposalHandler) throw new Error("no proposal handler installed");
      return proposalHandler("auth");
    },
  };
}

/** A promise the test can resolve at will, to hold an apply open mid-transaction. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("plan mode tool ownership", () => {
  it("borrows only write into Plan and hands only write back", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep", "bash", "xd://read"];
    await h.run("on html");

    expect(h.applies).toHaveLength(1);
    expect(h.applies[0].via).toBe("presentation");
    expect(h.applies[0].force).toBe(false);
    // The whole Build roster survives; write is the one addition.
    expect([...h.applies[0].enabled].sort()).toEqual(["bash", "grep", "read", "write", "xd://read"]);
    // The mounted projection is the intersection with the new enabled set.
    expect([...h.applies[0].mounted].sort()).toEqual(["xd://read"]);
    expect(h.guardArmed()).toBe(true);
    expect(h.status()?.enabled).toBe(true);

    // Capability toggles during Plan move the roster in both directions.
    h.root.enabled = ["read", "grep", "write", "skills", "xd://read", "xd://propose"];
    h.root.mounted = ["xd://read", "xd://propose"];
    await h.run("off");

    expect(h.applies).toHaveLength(2);
    // Exactly the PRESENT roster minus write: no resurrection of "bash", and the
    // Plan-time "skills" addition kept.
    expect([...h.applies[1].enabled].sort()).toEqual(
      ["grep", "read", "skills", "xd://propose", "xd://read"],
    );
    expect([...h.applies[1].mounted].sort()).toEqual(["xd://propose", "xd://read"]);
    expect(h.guardArmed()).toBe(false);
    expect(h.status()?.enabled).toBe(false);
    expect(h.proposalInstalled()).toBe(false);
    expect(h.log.filter((entry) => entry === "mode:plan")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "mode:none")).toHaveLength(1);
  });

  it("never touches a write the user already had, and applies nothing on exit", async () => {
    const h = runtimeHarness();
    await h.run("on html");

    // write was already enabled, so there is no borrow and no application at all.
    expect(h.applies).toHaveLength(0);
    expect(h.guardArmed()).toBe(true);

    await h.run("off");
    expect(h.applies).toHaveLength(0);
    expect(h.root.enabled).toContain("write");
    expect(h.guardArmed()).toBe(false);
  });

  it("hands write back only when the user left it on", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    await h.run("on html");
    expect(h.applies).toHaveLength(1);

    // Something else removed write mid-span (omp's own state, not a saved list).
    h.root.enabled = ["read", "grep", "skills"];
    await h.run("off");

    // No setter call, because nothing would change — and the mode still closed.
    expect(h.applies).toHaveLength(1);
    expect(h.guardArmed()).toBe(false);
    expect(h.root.enabled).toContain("skills");
  });

  it("does not enter the mode when the write borrow cannot be applied", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    await h.run("off"); // publishes the honest Build status first.
    expect(h.status()?.enabled).toBe(false);

    h.root.applyError = new Error("registry write refused");
    await expect(h.run("on html")).rejects.toThrow("registry write refused");

    expect(h.status()?.enabled).toBe(false);
    expect(h.guardArmed()).toBe(false);
    expect(h.proposalInstalled()).toBe(false);
    expect(h.log.filter((entry) => entry === "mode:plan")).toEqual([]);
    expect(h.root.enabled).toEqual(["read", "grep"]);

    // Ownership stayed false, so the following Build command applies nothing.
    h.root.applyError = null;
    await h.run("off");
    expect(h.applies).toHaveLength(1);
  });

  it("keeps guard, handler, and ownership when the handback cannot be applied", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    await h.run("on html");
    expect(h.applies).toHaveLength(1);

    h.root.applyError = new Error("registry write refused");
    await expect(h.run("off")).rejects.toThrow("registry write refused");

    // Half-tearing the mode down would leave the guard armed and the propose
    // gate live without a span to own them; a retryable failure is the truth.
    expect(h.guardArmed()).toBe(true);
    expect(h.proposalInstalled()).toBe(true);
    expect(h.root.enabled).toContain("write");
    expect(h.status()?.enabled).toBe(true);
    expect(h.log.filter((entry) => entry === "mode:none")).toEqual([]);

    // The ownership survived, so retrying hands write back for real.
    h.root.applyError = null;
    await h.run("off");
    expect(h.applies).toHaveLength(3);
    expect(h.applies[2].enabled).not.toContain("write");
    expect(h.guardArmed()).toBe(false);
  });

  it("drops ownership on a session-id change instead of un-writing a new session", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    await h.run("on html");
    expect(h.applies).toHaveLength(1);

    // /new: the same root object, a different session, whose own roster has write.
    h.root.id = "root-b";
    h.root.enabled = ["read", "grep", "write"];
    await h.run("off");

    expect(h.applies).toHaveLength(1);
    expect(h.root.enabled).toContain("write");
    expect(h.guardArmed()).toBe(false);
    expect(h.log.filter((entry) => entry === "mode:none")).toHaveLength(1);

    // Nothing is replayed from the dead span: the next entry borrows afresh.
    h.root.enabled = ["read", "grep", "skills"];
    await h.run("on html");
    expect(h.applies).toHaveLength(2);
    expect([...h.applies[1].enabled].sort()).toEqual(["grep", "read", "skills", "write"]);
  });

  it("runs both transitions inside omp's registry queue, ordered", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];

    // A capability mutation that took the queue first must land before the plan
    // entry reads, because the entry's read happens inside the lock, not before
    // it takes it.
    const queued = h.root.runToolRegistryMutation!(async () => {
      h.log.push("flip:other");
      h.root.enabled = [...h.root.enabled, "skills"];
    });
    await h.run("on html");
    await queued;

    const entryStart = h.log.indexOf("queue:enter");
    expect(entryStart).toBeGreaterThanOrEqual(0);
    expect(h.log.slice(entryStart, h.log.indexOf("queue:exit") + 1)).toEqual([
      "queue:enter",
      "flip:other",
      "queue:exit",
    ]);
    const entryApply = h.log.indexOf("queue:enter", entryStart + 1);
    expect(h.log.slice(entryApply, h.log.indexOf("queue:exit", entryApply) + 1)).toEqual([
      "queue:enter",
      "read:enabled",
      "read:roster",
      "read:mounted",
      "apply:presentation",
      "queue:exit",
    ]);
    expect(h.applies[0].enabled).toContain("skills");
    expect(h.root.queueLocks).toBe(0);

    // A toggle that arrives while the exit holds the lock queues behind it.
    const hold = deferred();
    h.root.applyHold = hold.promise;
    const exiting = h.run("off");
    for (let spins = 0; h.root.queueLocks === 0 && spins < 1000; spins += 1) {
      await Promise.resolve();
    }
    expect(h.root.queueLocks).toBe(1);
    const rival = h.root.runToolRegistryMutation!(async () => {
      h.log.push("rival");
      h.root.enabled = [...h.root.enabled, "late"];
    });
    expect(h.log).not.toContain("rival");
    hold.resolve();
    await exiting;
    await rival;

    expect(h.root.queueLocks).toBe(0);
    expect(h.applies).toHaveLength(2);
    expect(h.applies[1].enabled).not.toContain("write");
    // The rival's toggle serialized behind the exit instead of landing inside
    // its read-then-apply window, and it survived: nothing replayed over it.
    expect(h.log.indexOf("rival")).toBeGreaterThan(h.log.lastIndexOf("apply:presentation"));
    expect(h.root.enabled).toContain("late");
  });

  it("never retargets the transaction object onto a prompting descendant", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    const child = h.spawn("descendant");
    const childRoster = [...child.enabled];
    void child.prompt();

    await h.run("on html");
    expect(h.root.enabled).toContain("write");
    expect([...child.enabled]).toEqual(childRoster);
    // The wrapper is prototype-deep, so a prompting descendant sees the guard
    // exactly as the root does even though no transaction ever runs on it.
    expect(h.guardArmed(child)).toBe(true);

    await h.run("off");
    expect(h.root.enabled).not.toContain("write");
    expect([...child.enabled]).toEqual(childRoster);
    expect(h.guardArmed(child)).toBe(false);
  });

  it("adds and removes just write through the by-name setter on an omp without it", async () => {
    const h = runtimeHarness({ legacyApply: true, noQueue: true, noInfos: true, noXdev: true });
    h.root.enabled = ["read", "grep"];
    await h.run("on html");

    expect(h.applies).toHaveLength(1);
    expect(h.applies[0].via).toBe("by-name");
    expect([...h.applies[0].enabled].sort()).toEqual(["grep", "read", "write"]);

    h.root.enabled = ["read", "write", "bash"];
    await h.run("off");

    expect(h.applies).toHaveLength(2);
    expect([...h.applies[1].enabled].sort()).toEqual(["bash", "read"]);
    expect(h.guardArmed()).toBe(false);
    expect(h.status()?.enabled).toBe(false);
  });

  it("applies a transition while the session streams; transitions are not busy-gated", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    h.root.isStreaming = true;
    h.root.queuedMessageCount = 2;

    await h.run("on html");

    expect(h.applies).toHaveLength(1);
    expect(h.applies[0].enabled).toContain("write");
    // The entry instruction steers into the live turn rather than waiting.
    expect(h.sent.at(-1)?.deliverAs).toBe("steer");
    expect(h.guardArmed()).toBe(true);
  });

  it("does not report a transition the queue never ran", async () => {
    const h = runtimeHarness();
    h.root.enabled = ["read", "grep"];
    h.root.queueSwallowsWork = true;

    await expect(h.run("on html")).rejects.toThrow("never ran the transition");

    // Nothing was applied and nothing was armed: a queue that swallows the
    // callback cannot be mistaken for a completed borrow into the mode.
    expect(h.applies).toHaveLength(0);
    expect(h.guardArmed()).toBe(false);
    expect(h.proposalInstalled()).toBe(false);
    expect(h.root.enabled).toEqual(["read", "grep"]);
  });
});
