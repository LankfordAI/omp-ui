import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodePlanPreflightReply,
  PLAN_ARTIFACT_BYTE_LIMIT,
  PLAN_PREFLIGHT_RESULT_PREFIX,
  PLAN_TRANSCRIPT_COMMAND,
  PLAN_TRANSCRIPT_STATUS_KEY,
  parseTranscriptPlanStatus,
  type TranscriptPlanSelection,
  type TranscriptPlanStatus,
  PLAN_COMMAND,
  PLAN_REVIEW_SENTINEL,
  PLAN_STATUS_KEY,
  type PlanReviewRequest,
  type PlanStatus,
} from "./plan";
import { planExtensionPath, writePlanExtension } from "./plan-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

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

  it("writes a strict TypeScript extension omp can load", () => {
    typecheckGeneratedExtension(writePlanExtension(tempLineage()));
  });
});

/** The fake AgentSession's record of one hidden custom message. */
interface SentMessage {
  customType: string;
  content: string;
  deliverAs: string;
  triggerTurn?: boolean;
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
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
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
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "esm");
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
function executableExtension(fsOverrides: Partial<typeof fs> = {}): ExtensionFactory {
  const file = writePlanExtension(tempLineage());
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const loaded = { exports: {} as { default?: ExtensionFactory } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports,
    (name: string) => name === "node:fs" ? { ...fs, ...fsOverrides } : nodeRequire(name));
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
  transcript: (args: string) => Promise<void>;
  transcriptStatus: () => TranscriptPlanStatus | null;
  replaceManager: () => void;
  /** Fire without awaiting, to interleave two transitions. */
  dispatch: (args: string) => Promise<void>;
  /** Drive omp's propose gate through the handler the extension installed. */
  propose: (title: string) => Promise<ToolResult>;
  /** The plan review request the extension packed behind the sentinel. */
  reviewed: () => PlanReviewRequest | null;
  status: () => PlanStatus | null;
  /** What omp's write guard sees. */
  guardArmed: () => boolean;
  /** The path pinned as the session's plan reference when the user executes. */
  referencePath: () => string | null;
  /** Titles omp's own markdown plan resolver was asked to resolve. */
  prepared: string[];
  /** Titles handed to `ui.select`. */
  selects: string[];
  /** The option lists handed to each `ui.select`, in call order. */
  selectOptions: string[][];
  /** Choose what the next `ui.select` answers with. */
  answer: (value: string | undefined) => void;
  /** Only with the `heldSelect` option: resolves the select in flight. */
  release?: (value: string | undefined) => void;
  sent: SentMessage[];
  tools: () => string[];
  notices: string[];
  /** Fire a session event and drain the extension's delivery chain. */
  fire: (event: string) => Promise<void>;
}

interface TranscriptFixture {
  sessionId: string;
  sessionDir: string;
  artifactsDir: string;
  entries: Array<{ id: string; type: string; message: { role: string; stopReason?: string; content: unknown } }>;
  branch: unknown[];
  streaming: boolean;
  compacting: boolean;
  goal?: unknown;
  instructionHold?: Promise<void>;
  onInstruction?: () => void;
}

function harness(
  factory: ExtensionFactory,
  options?: {
    canSendMessages?: boolean;
    artifactsDir?: string | null;
    markdownPlan?: boolean;
    /** Hold every select on a pending promise until `release` answers it. */
    heldSelect?: boolean;
    /** Report vibe mode on, the way the vibe bridge's session reports it. */
    vibeEnabled?: boolean;
    transcript?: TranscriptFixture;
  },
): Harness {
  const sent: SentMessage[] = [];
  const notices: string[] = [];
  const prepared: string[] = [];
  const selects: string[] = [];
  const selectOptions: string[][] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let tools = ["read", "grep", "write"];
  let planState: { enabled: boolean } | undefined;
  let proposalHandler: ((title: string) => Promise<ToolResult>) | undefined;
  let referencePath: string | null = null;
  let answer: string | undefined;
  let releaseHeld: ((value: string | undefined) => void) | null = null;

  // A fresh class per harness: the extension patches prototype methods.
  class FakeSession {
    get isStreaming(): boolean { return options?.transcript?.streaming ?? false; }
    get isCompacting(): boolean { return options?.transcript?.compacting ?? false; }
    sessionManager = {
      // An explicit `null` must survive: that is the omp that cannot host html plans.
      getArtifactsDir: () => options?.transcript?.artifactsDir ??
        (options?.artifactsDir !== undefined ? options.artifactsDir : "/tmp/omp-ui-fake-artifacts"),
      ...(options?.transcript ? {
        getSessionDir: () => options.transcript!.sessionDir,
        getSessionId: () => options.transcript!.sessionId,
        getEntry: (id: string) => options.transcript!.entries.find(entry => entry.id === id),
        getBranch: () => options.transcript!.branch,
      } : {}),
      appendModeChange: () => undefined,
    };
    getPlanModeState(): { enabled: boolean } | undefined {
      return planState;
    }
    getGoalModeState(): unknown { return options?.transcript?.goal; }
    getVibeModeState(): { enabled: boolean } | undefined {
      return options?.vibeEnabled === true ? { enabled: true } : undefined;
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
        opts: { deliverAs: string; triggerTurn?: boolean },
      ) {
        sent.push({ customType: msg.customType, content: msg.content, deliverAs: opts.deliverAs, triggerTurn: opts.triggerTurn });
        options?.transcript?.onInstruction?.();
        if (options?.transcript?.instructionHold) await options.transcript.instructionHold;
        return false;
      },
      writable: true,
      configurable: true,
    });
  }

  const handlers = new Map<string, (args: string, ctx: { ui: PlanUi }) => Promise<void>>();
  const statuses = new Map<string, string | undefined>();
  const ui: PlanUi = {
    setStatus: (key, text) => {
      statuses.set(key, text);
    },
    select: async (title, optionList) => {
      selects.push(title);
      selectOptions.push([...optionList]);
      if (options?.heldSelect === true) {
        return new Promise<string | undefined>((resolve) => {
          releaseHeld = resolve;
        });
      }
      return answer;
    },
    notify: (message) => {
      notices.push(message);
    },
  };

  factory({
    pi: { AgentSession: { prototype: FakeSession.prototype as unknown as Record<string, unknown> } },
    registerCommand: (name, opts) => {
      handlers.set(name, opts.handler);
    },
    on: (event, fn) => {
      (listeners[event] ??= []).push(fn);
    },
  });

  const session = new FakeSession();
  // The extension captures the session off prompt; omp dispatches slash commands
  // from inside prompt, so this is what a real toggle does first.
  void session.prompt();

  const dispatchCommand = (name: string, args: string): Promise<void> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error("the extension registered no command: " + name);
    return handler(args, { ui });
  };
  const dispatch = (args: string) => dispatchCommand(PLAN_COMMAND, args);
  return {
    run: dispatch,
    dispatch,
    transcript: (args) => dispatchCommand(PLAN_TRANSCRIPT_COMMAND, args),
    transcriptStatus: () => parseTranscriptPlanStatus(statuses.get(PLAN_TRANSCRIPT_STATUS_KEY)),
    replaceManager: () => { session.sessionManager = { ...session.sessionManager }; },
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
    status: () => {
      const text = statuses.get(PLAN_STATUS_KEY);
      return text === undefined ? null : JSON.parse(text);
    },
    guardArmed: () => session.getPlanModeState()?.enabled === true,
    referencePath: () => referencePath,
    prepared,
    selects,
    selectOptions,
    answer: (value) => {
      answer = value;
    },
    ...(options?.heldSelect === true
      ? {
          release: (value: string | undefined) => {
            const resolve = releaseHeld;
            releaseHeld = null;
            resolve?.(value);
          },
        }
      : {}),
    sent,
    tools: () => [...tools],
    notices,
    fire: async (event) => {
      for (const fn of listeners[event] ?? []) fn();
      // The event path chains sendModeInstruction without awaiting it.
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
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

  it("ends the turn on dismiss without pinning or exiting", async () => {
    // Dismiss answers the gate but approves nothing and reworks nothing: plan
    // mode stays armed, nothing is pinned, no exit rides the message bus, and
    // the ToolResult tells the agent to stop.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    h.answer("dismiss");
    const result = await h.propose("auth");

    expect(result.isError).toBeFalsy();
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("dismissed");
    expect(text).toContain("Do NOT implement");
    expect(h.guardArmed()).toBe(true);
    expect(h.referencePath()).toBeNull();
    expect(exits(h.sent)).toHaveLength(0);
    expect(h.status()?.approved).toBe(false);
    expect(h.selectOptions.at(-1)).toEqual(["execute", "refine", "dismiss"]);
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

  it("refuses entry while vibe mode holds the mode slot", async () => {
    const h = harness(await loadExtension(), { vibeEnabled: true });
    await h.run("on html");

    expect(h.notices).toContain("Exit vibe mode before entering Plan mode.");
    expect(h.status()?.enabled).toBe(false);
    expect(h.guardArmed()).toBe(false);
    expect(entries(h.sent)).toHaveLength(0);
  });
});

describe("instruction survives session rebuilds", () => {
  // Issue #877: a mid-turn compaction rebuilt the context the entry
  // instruction lived in, the summary carried neither the instruction nor the
  // duty to propose, and the planning turn ended with no xd://propose call.
  it.each(["session_compact", "session_branch", "session_switch"])(
    "re-delivers the entry instruction after %s",
    async (event) => {
      const h = harness(await loadExtension());
      await h.run("on html");
      await h.fire(event);

      const copies = entries(h.sent);
      expect(copies).toHaveLength(2);
      expect(copies[1]?.content).toBe(copies[0]?.content);
      expect(exits(h.sent)).toHaveLength(0);
      // The re-sent copy still carries the html contract: the plan is the
      // html file (the md body names only -plan.md; the html body mentions
      // -plan.md solely to forbid it).
      expect(copies[1]?.content).toContain("-plan.html");
    },
  );

  it("re-queues once per event, every event", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");
    await h.fire("session_compact");
    await h.fire("session_compact");

    // Deliberate duplicate delivery: entry supersedes stale copies by name
    // (ADR-0013), so stacking re-sends is safe and the vault precedent does it.
    expect(entries(h.sent)).toHaveLength(3);
  });

  it("stays silent after an exit, so an un-armed session gets no zombie instruction", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");
    await h.run("off");
    await h.fire("session_compact");

    expect(entries(h.sent)).toHaveLength(1);
    expect(exits(h.sent)).toHaveLength(1);
  });

  it("re-sends the current format, never a format the user toggled away", async () => {
    const h = harness(await loadExtension());
    await h.run("on html");
    await h.run("off");
    await h.run("on md");
    await h.fire("session_compact");

    const last = entries(h.sent).at(-1);
    expect(last?.content).toContain("-plan.md");
    expect(last?.content).not.toContain("-plan.html");
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
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
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
    setStatus: (key, text) => {
      if (key === PLAN_STATUS_KEY) statusText = text;
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
    registerCommand: (name, opts) => {
      if (name === PLAN_COMMAND) handler = opts.handler;
    },
    on: (event, fn) => {
      (listeners[event] ??= []).push(fn);
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
    fire: async (event: string) => {
      for (const fn of listeners[event] ?? []) fn();
      // The event path chains sendModeInstruction without awaiting it.
      for (let i = 0; i < 12; i++) await Promise.resolve();
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

describe("re-presenting a plan (ADR-0033)", () => {
  it("reviews exactly the named plan, newest file be damned", async () => {
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000); // older
    writePlanFile(artifacts, "login-plan.html", 1_800_000_000); // newer
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    h.answer("refine");
    await h.run("review local://auth-plan.html Auth plan");

    expect(h.reviewed()).toMatchObject({
      title: "Auth plan",
      planFilePath: "local://auth-plan.html",
      represented: true,
    });
    // The named file skips omp's title resolver entirely.
    expect(h.prepared).toEqual([]);
  });

  it("a re-presented dismiss keeps plan mode armed and unapproved", async () => {
    // The represented review shares onProposal, so its ToolResult is ignored
    // exactly like refine's; the state effects are what matter here.
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    h.answer("dismiss");
    await h.run("review local://auth-plan.html Auth plan");

    expect(h.guardArmed()).toBe(true);
    expect(h.status()?.approved).toBe(false);
    expect(h.referencePath()).toBeNull();
    expect(exits(h.sent)).toHaveLength(0);
  });

  it("a re-presented execute pins, exits, and announces the retraction", async () => {
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    h.answer("execute");
    await h.run("review local://auth-plan.html Auth plan");

    expect(h.referencePath()).toBe("local://auth-plan.html");
    expect(h.guardArmed()).toBe(false);
    // No blocked ToolResult tells the agent anything: the exit retraction is
    // the only channel, so it must be sent (the agent path sends none).
    expect(exits(h.sent)).toHaveLength(1);

    const agentPath = harness(await loadExtension(), { artifactsDir: artifacts });
    agentPath.answer("execute");
    await agentPath.run("on html");
    await agentPath.propose("auth");
    expect(exits(agentPath.sent)).toHaveLength(0);
  });

  it("reads a preflight reply as a reply even in an md session", async () => {
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on md");
    const reply = encodePlanPreflightReply("local://auth-plan.html", {
      status: "failed",
      sourceHash: null,
      diagnostics: [
        {
          code: "HTML_PARSE_ERROR",
          stage: "source",
          repair: "source",
          severity: "error",
          message: "unclosed tag",
        },
      ],
    });
    h.answer(reply);
    await h.run("review local://auth-plan.html Auth plan");

    // The artifact is html even though the session format is md: the failed
    // preflight reply must answer with diagnostics, NOT masquerade as a refine.
    expect(
      h.notices.some((n) => n.includes("Plan preflight failed for local://auth-plan.html")),
    ).toBe(true);
    expect(h.guardArmed()).toBe(true);
    expect(h.referencePath()).toBeNull();
  });

  it("refuses a missing plan file with a notice and no gate", async () => {
    const artifacts = tempArtifacts();
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("on html");
    await h.run("review local://gone-plan.html Gone");

    expect(
      h.notices.some((n) => n.includes("Plan file not found: local://gone-plan.html")),
    ).toBe(true);
    expect(h.selects).toEqual([]);
  });

  it("refuses a proposal while a re-presented review is open", async () => {
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts, heldSelect: true });
    await h.run("on html");
    const reviewing = h.run("review local://auth-plan.html Auth plan");
    await vi.waitFor(() => expect(h.selects).toHaveLength(1));

    const result = await h.propose("auth");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("already open");
    expect(h.selects).toHaveLength(1); // no second gate stacked behind the first

    h.answer("refine");
    h.release?.("refine");
    await reviewing;
  });

  it("warns instead of gating when Plan mode is off", async () => {
    const artifacts = tempArtifacts();
    writePlanFile(artifacts, "auth-plan.html", 1_700_000_000);
    const h = harness(await loadExtension(), { artifactsDir: artifacts });
    await h.run("review local://auth-plan.html Auth plan");

    expect(
      h.notices.some((n) => n.includes("needs Plan mode")),
    ).toBe(true);
    expect(h.selects).toEqual([]);
  });
});

function transcriptFixture(content = "<!doctype html>\r\n<html><body>Exact &amp; 😀 source</body></html>\r\n"): TranscriptFixture {
  const sessionDir = tempLineage();
  const entries: TranscriptFixture["entries"] = [
    { id: "earlier-identical", type: "message", message: { role: "user", content } },
    { id: "selected-entry", type: "message", message: { role: "assistant", stopReason: "stop", content } },
  ];
  return {
    sessionId: "source-session", sessionDir, artifactsDir: path.join(sessionDir, "artifacts"),
    entries, branch: entries, streaming: false, compacting: false,
  };
}

function transcriptSelection(fixture: TranscriptFixture, overrides: Partial<TranscriptPlanSelection> = {}): TranscriptPlanSelection {
  const entry = fixture.entries.find(item => item.id === (overrides.entryId ?? "selected-entry"))!;
  const index = overrides.contentIndex ?? null;
  const content = entry.message.content;
  const part = index === null ? content as string : (content as Array<{ text: string }>)[index]!.text;
  const start = overrides.start ?? 0;
  const end = overrides.end ?? part.length;
  return {
    version: 1, requestId: randomUUID(), sessionId: fixture.sessionId, entryId: entry.id,
    contentIndex: index, start, end, title: "Transcript plan",
    contentHash: createHash("sha256").update(part, "utf8").digest("hex"),
    sourceHash: createHash("sha256").update(part.slice(start, end), "utf8").digest("hex"),
    ...overrides,
  };
}

function adoptTranscript(h: Harness, selection: unknown): Promise<void> {
  return h.transcript(`adopt ${JSON.stringify(selection)}`);
}

describe("exact transcript plan adoption", () => {
  it("advertises adoption separately and show neither enters Plan nor waits behind a review", async () => {
    const fixture = transcriptFixture();
    const h = harness(executableExtension(), { transcript: fixture, heldSelect: true });
    await h.transcript("show");
    expect(h.transcriptStatus()).toMatchObject({ available: true, busy: false, result: null, sessionId: fixture.sessionId });
    expect(h.guardArmed()).toBe(false);
    expect(h.sent).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
    const selection = transcriptSelection(fixture);
    const adopting = adoptTranscript(h, selection);
    await vi.waitFor(() => expect(h.selects).toHaveLength(1));
    await h.transcript("show");
    expect(h.transcriptStatus()).toMatchObject({ busy: true, result: { requestId: selection.requestId, status: "captured" } });
    h.release?.("dismiss");
    await adopting;
  });

  it("disables only adoption when exact source APIs are absent", async () => {
    const h = harness(executableExtension());
    await h.transcript("show");
    expect(h.transcriptStatus()).toMatchObject({ available: false, result: null });
    await h.run("on md");
    expect(h.guardArmed()).toBe(true);
    expect(entries(h.sent)).toHaveLength(1);
  });

  it("writes the selected second occurrence as exact bytes with provenance and never chooses a newer plan", async () => {
    const html = "  <!doctype html>\r\n<html><body>😀 &amp; &#x26;</body></html>\r\n";
    const part = "First\r\n```html\r\n" + html + "```\r\nSecond\r\n```HTML\r\n" + html + "```\r\n";
    const fixture = transcriptFixture(part);
    fs.mkdirSync(path.join(fixture.artifactsDir, "local"), { recursive: true });
    const newer = writePlanFile(fixture.artifactsDir, "newer-plan.html", 2_000_000_000);
    const newerBytes = fs.readFileSync(newer);
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("dismiss");
    const start = part.lastIndexOf(html);
    const selection = transcriptSelection(fixture, { start, end: start + html.length, title: "Exact selected HTML" });
    await adoptTranscript(h, { ...selection, body: "not authoritative", planFilePath: "local://newer-plan.html", slug: "newer" });
    const name = `transcript-${selection.requestId}-plan`;
    const captured = fs.readFileSync(path.join(fixture.artifactsDir, "local", name + ".html"));
    expect(captured).toEqual(Buffer.from(html, "utf8"));
    expect(createHash("sha256").update(captured).digest("hex")).toBe(selection.sourceHash);
    expect(fs.readFileSync(newer)).toEqual(newerBytes);
    const sidecar = JSON.parse(fs.readFileSync(path.join(fixture.artifactsDir, "local", name + ".source.json"), "utf8"));
    expect(sidecar).toMatchObject({ ...selection, role: "assistant" });
    expect(Number.isFinite(Date.parse(sidecar.importedAt))).toBe(true);
    expect(sidecar).not.toHaveProperty("body");
    expect(sidecar).not.toHaveProperty("text");
    // Windows has no POSIX permission bits to check.
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(fixture.artifactsDir, "local", name + ".html")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(fixture.artifactsDir, "local", name + ".source.json")).mode & 0o777).toBe(0o600);
    }
    expect(h.reviewed()).toMatchObject({ planFilePath: `local://${name}.html`, title: selection.title, represented: true });
    expect(h.prepared).toEqual([]);
    expect(h.transcriptStatus()).toMatchObject({ busy: false, result: { status: "settled", requestId: selection.requestId } });
    expect(h.referencePath()).toBeNull();
    expect(h.guardArmed()).toBe(true);
    expect(h.sent.every(message => message.triggerTurn === false)).toBe(true);
  });

  it("creates only the missing local directory and keeps an existing markdown span unchanged", async () => {
    const fixture = transcriptFixture();
    fs.mkdirSync(fixture.artifactsDir);
    const h = harness(executableExtension(), { transcript: fixture });
    await h.run("on md");
    const before = entries(h.sent);
    h.answer("refine");
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(fs.statSync(path.join(fixture.artifactsDir, "local")).isDirectory()).toBe(true);
    expect(entries(h.sent)).toEqual(before);
    expect(h.guardArmed()).toBe(true);
    expect(h.referencePath()).toBeNull();
    expect(h.prepared).toEqual([]);
  });

  it("reads the original array text part index without joining non-text parts", async () => {
    const fixture = transcriptFixture();
    const html = fixture.entries[1]!.message.content as string;
    fixture.entries[1]!.message.content = [{ type: "thinking", thinking: html }, { type: "text", text: "not html" }, { type: "text", text: html }];
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("dismiss");
    const selection = transcriptSelection(fixture, { contentIndex: 2 });
    await adoptTranscript(h, selection);
    const file = path.join(fixture.artifactsDir, "local", `transcript-${selection.requestId}-plan.html`);
    expect(fs.readFileSync(file, "utf8")).toBe(html);
  });

  it.each(["user", "assistant-toolUse"])("accepts eligible %s source messages", async (kind) => {
    const fixture = transcriptFixture();
    fixture.entries[1]!.message.role = kind === "user" ? "user" : "assistant";
    fixture.entries[1]!.message.stopReason = kind === "user" ? undefined : "toolUse";
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("dismiss");
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.selects).toHaveLength(1);
  });

  it.each(["error", "aborted", "length", "unknown"])("rejects unfinished assistant stop reason %s", async (stopReason) => {
    const fixture = transcriptFixture();
    fixture.entries[1]!.message.stopReason = stopReason;
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "invalid-source" });
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["session", "offbranch", "content-hash", "slice-hash", "range", "incomplete", "non-message", "tool", "duplicate-branch"])("rejects %s sources before writing or opening a gate", async (kind) => {
    const fixture = transcriptFixture();
    const selection = transcriptSelection(fixture);
    if (kind === "session") selection.sessionId = "previous-session";
    if (kind === "offbranch") fixture.branch = [fixture.entries[0]];
    if (kind === "content-hash") selection.contentHash = "0".repeat(64);
    if (kind === "slice-hash") selection.sourceHash = "0".repeat(64);
    if (kind === "range") selection.end += 1;
    if (kind === "incomplete") {
      fixture.entries[1]!.message.content = "<html>not finished";
      Object.assign(selection, transcriptSelection(fixture));
    }
    if (kind === "non-message") fixture.entries[1]!.type = "custom";
    if (kind === "tool") fixture.entries[1]!.message.role = "toolResult";
    if (kind === "duplicate-branch") fixture.branch = [...fixture.entries, fixture.entries[1]];
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", requestId: selection.requestId });
    expect(h.selects).toEqual([]);
    expect(h.guardArmed()).toBe(false);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["start", "end"])("rejects a surrogate-split %s boundary even when its lossy UTF-8 hash matches", async (boundary) => {
    const fixture = transcriptFixture("😀<html><body>ok</body></html>😀");
    const part = fixture.entries[1]!.message.content as string;
    const selection = transcriptSelection(fixture, boundary === "start" ? { start: 1, end: part.length - 2 } : { start: 2, end: part.length - 1 });
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "invalid-source" });
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["negative-index", "fractional-offset", "empty-range", "title-newline", "title-control", "uppercase-hash", "invalid-version"])("retains an invalid-request receipt for %s", async (kind) => {
    const fixture = transcriptFixture();
    const selection = transcriptSelection(fixture);
    const changed: Record<string, unknown> = { ...selection };
    if (kind === "negative-index") changed.contentIndex = -1;
    if (kind === "fractional-offset") changed.start = 0.5;
    if (kind === "empty-range") changed.end = 0;
    if (kind === "title-newline") changed.title = "two\nlines";
    if (kind === "title-control") changed.title = "two\u0085lines";
    if (kind === "uppercase-hash") changed.contentHash = "A".repeat(64);
    if (kind === "invalid-version") changed.version = 2;
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, changed);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "invalid-request", requestId: selection.requestId });
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it("rejects malformed and over-limit requests without changing Plan or creating directories", async () => {
    const fixture = transcriptFixture();
    const h = harness(executableExtension(), { transcript: fixture });
    await h.transcript("adopt {broken");
    await h.transcript("adopt " + JSON.stringify({ ...transcriptSelection(fixture), padding: "😀".repeat(4096) }));
    expect(h.notices).toHaveLength(2);
    expect(h.guardArmed()).toBe(false);
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["streaming", "compacting"])("synchronously refuses %s admission without queueing a future gate", async (key) => {
    const fixture = transcriptFixture();
    fixture[key as "streaming" | "compacting"] = true;
    const h = harness(executableExtension(), { transcript: fixture });
    const selection = transcriptSelection(fixture);
    const result = adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result).toMatchObject({ code: "busy", requestId: selection.requestId });
    fixture.streaming = fixture.compacting = false;
    await result;
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it("reserves before queueing and excludes both another adoption and model proposals until settlement", async () => {
    const fixture = transcriptFixture();
    const hold = deferred();
    fixture.instructionHold = hold.promise;
    const h = harness(executableExtension(), { transcript: fixture, heldSelect: true });
    const first = transcriptSelection(fixture);
    const second = transcriptSelection(fixture);
    const adopting = adoptTranscript(h, first);
    await adoptTranscript(h, second);
    expect(h.transcriptStatus()?.result).toMatchObject({ code: "busy", requestId: second.requestId });
    await vi.waitFor(() => expect(entries(h.sent)).toHaveLength(1));
    const third = transcriptSelection(fixture);
    await adoptTranscript(h, third);
    expect(h.transcriptStatus()?.result).toMatchObject({ code: "busy", requestId: third.requestId });
    hold.resolve();
    await vi.waitFor(() => expect(h.selects).toHaveLength(1));
    await h.run("review local://existing-plan.html Existing");
    expect(h.selects).toHaveLength(1);
    const proposal = await h.propose("ignored");
    expect(proposal.isError).toBe(true);
    expect(h.selects).toHaveLength(1);
    h.release?.("dismiss");
    await adopting;
    expect(h.transcriptStatus()?.busy).toBe(false);
    expect(fs.readdirSync(path.join(fixture.artifactsDir, "local"))).toHaveLength(2);
  });

  it("rejects adoption while an existing represented review is open", async () => {
    const fixture = transcriptFixture();
    fs.mkdirSync(path.join(fixture.artifactsDir, "local"), { recursive: true });
    writePlanFile(fixture.artifactsDir, "existing-plan.html", 1);
    const h = harness(executableExtension(), { transcript: fixture, heldSelect: true });
    await h.run("on html");
    const reviewing = h.run("review local://existing-plan.html Existing");
    await vi.waitFor(() => expect(h.selects).toHaveLength(1));
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()?.result).toMatchObject({ code: "busy" });
    expect(fs.readdirSync(path.join(fixture.artifactsDir, "local"))).toEqual(["existing-plan.html"]);
    h.release?.("dismiss");
    await reviewing;
  });

  it.each(["goal", "vibe"])("respects the existing %s mode blocker without creating a file", async (kind) => {
    const fixture = transcriptFixture();
    if (kind === "goal") fixture.goal = { goal: { status: "paused" } };
    const h = harness(executableExtension(), { transcript: fixture, vibeEnabled: kind === "vibe" });
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "unavailable" });
    expect(h.guardArmed()).toBe(false);
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["session", "manager", "source", "role", "branch", "artifacts", "streaming", "compacting"])("rechecks %s after asynchronous Plan entry and leaves the guard armed", async (kind) => {
    const fixture = transcriptFixture();
    const originalArtifacts = fixture.artifactsDir;
    const hold = deferred();
    fixture.instructionHold = hold.promise;
    const h = harness(executableExtension(), { transcript: fixture });
    const adopting = adoptTranscript(h, transcriptSelection(fixture));
    await vi.waitFor(() => expect(entries(h.sent)).toHaveLength(1));
    if (kind === "session") fixture.sessionId = "replacement-session";
    if (kind === "manager") h.replaceManager();
    if (kind === "role") fixture.entries[1]!.message.role = "user";
    if (kind === "source") fixture.entries[1]!.message.content = "<html>changed</html>";
    if (kind === "branch") fixture.branch = [fixture.entries[0]];
    if (kind === "artifacts") fixture.artifactsDir = path.join(fixture.sessionDir, "replacement");
    if (kind === "streaming") fixture.streaming = true;
    if (kind === "compacting") fixture.compacting = true;
    hold.resolve();
    await adopting;
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed" });
    expect(h.guardArmed()).toBe(true);
    expect(h.referencePath()).toBeNull();
    expect(h.selects).toEqual([]);
    expect(fs.existsSync(originalArtifacts)).toBe(false);
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
  });

  it.each(["stem-symlink", "local-symlink", "stem-file", "local-file", "escape", "nested-parent"])("rejects %s confinement violations without touching their targets", async (kind) => {
    const fixture = transcriptFixture();
    const outside = tempLineage();
    const sentinel = path.join(outside, "keep");
    fs.writeFileSync(sentinel, "untouched");
    if (kind === "stem-symlink") fs.symlinkSync(outside, fixture.artifactsDir);
    if (kind === "stem-file") fs.writeFileSync(fixture.artifactsDir, "untouched");
    if (kind === "local-symlink" || kind === "local-file") {
      fs.mkdirSync(fixture.artifactsDir);
      if (kind === "local-symlink") fs.symlinkSync(outside, path.join(fixture.artifactsDir, "local"));
      else fs.writeFileSync(path.join(fixture.artifactsDir, "local"), "untouched");
    }
    if (kind === "escape") fixture.artifactsDir = path.join(outside, "escaped");
    if (kind === "nested-parent") fixture.artifactsDir = path.join(fixture.sessionDir, "missing", "nested");
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "unavailable" });
    expect(h.selects).toEqual([]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(fs.readdirSync(outside)).toEqual(["keep"]);
    if (kind === "nested-parent") expect(fs.existsSync(path.join(fixture.sessionDir, "missing"))).toBe(false);
  });

  it.each(["html", "sidecar", "html-symlink", "sidecar-symlink"])("never overwrites a %s collision and removes only its own partial files", async (kind) => {
    const fixture = transcriptFixture();
    const selection = transcriptSelection(fixture);
    const local = path.join(fixture.artifactsDir, "local");
    fs.mkdirSync(local, { recursive: true });
    const name = `transcript-${selection.requestId}-plan`;
    const collision = path.join(local, name + (kind.startsWith("html") ? ".html" : ".source.json"));
    const outside = path.join(tempLineage(), "target");
    fs.writeFileSync(outside, "untouched target");
    if (kind.endsWith("symlink")) fs.symlinkSync(outside, collision);
    else fs.writeFileSync(collision, "untouched collision");
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "write-failed" });
    expect(fs.readdirSync(local)).toEqual([path.basename(collision)]);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched target");
    if (kind.endsWith("symlink")) expect(fs.lstatSync(collision).isSymbolicLink()).toBe(true);
    else expect(fs.readFileSync(collision, "utf8")).toBe("untouched collision");
    expect(h.selects).toEqual([]);
    expect(h.referencePath()).toBeNull();
    expect(h.guardArmed()).toBe(true);
  });

  it("cleans both exclusively created files when the sidecar write fails and releases admission", async () => {
    const fixture = transcriptFixture();
    let writes = 0;
    const realWrite: typeof fs.writeSync = fs.writeSync;
    const faultyWrite = ((...args: Parameters<typeof fs.writeSync>) => {
      writes += 1;
      if (writes === 2) throw new Error("disk full");
      return Reflect.apply(realWrite, fs, args);
    }) as typeof fs.writeSync;
    const h = harness(executableExtension({ writeSync: faultyWrite }), { transcript: fixture });
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()).toMatchObject({ busy: false, result: { status: "failed", code: "write-failed" } });
    expect(fs.readdirSync(path.join(fixture.artifactsDir, "local"))).toEqual([]);
    expect(h.selects).toEqual([]);
    h.answer("dismiss");
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.selects).toHaveLength(1);
  });

  it.each([0, 1])("enforces the UTF-8 artifact ceiling at limit + %i bytes", async (extra) => {
    const shell = "<html></html>";
    const fixture = transcriptFixture("<html>" + "a".repeat(PLAN_ARTIFACT_BYTE_LIMIT - Buffer.byteLength(shell) + extra) + "</html>");
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("dismiss");
    const selection = transcriptSelection(fixture);
    await adoptTranscript(h, selection);
    if (extra === 0) {
      expect(h.selects).toHaveLength(1);
      expect(fs.statSync(path.join(fixture.artifactsDir, "local", `transcript-${selection.requestId}-plan.html`)).size).toBe(PLAN_ARTIFACT_BYTE_LIMIT);
    } else {
      expect(h.transcriptStatus()?.result).toMatchObject({ code: "over-limit" });
      expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
      expect(h.selects).toEqual([]);
    }
  });

  it.each(["failed", "unavailable", "malformed"])("retains %s preflight diagnostics and a saved copy without approval or pinning", async (kind) => {
    const fixture = transcriptFixture();
    const selection = transcriptSelection(fixture);
    const planFilePath = `local://transcript-${selection.requestId}-plan.html`;
    const failure = {
      status: kind === "unavailable" ? "unavailable" as const : "failed" as const,
      sourceHash: selection.sourceHash,
      diagnostics: [{ code: "HTML_PARSE_ERROR" as const, stage: "source" as const, repair: "source" as const,
        severity: "error" as const, message: "unclosed tag", location: { line: 2, column: 1, startOffset: 16, endOffset: 20 } }],
    };
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer(kind === "malformed" ? PLAN_PREFLIGHT_RESULT_PREFIX + "{broken" : encodePlanPreflightReply(planFilePath, failure));
    await adoptTranscript(h, selection);
    const result = h.transcriptStatus()?.result;
    expect(result).toMatchObject({ status: "failed", code: "preflight", requestId: selection.requestId, planFilePath });
    if (kind === "malformed") expect(result).toMatchObject({ preflight: { status: "unavailable", diagnostics: [{ repair: "application" }] } });
    else expect(result).toMatchObject({ preflight: failure });
    expect(h.referencePath()).toBeNull();
    expect(h.status()?.approved).toBe(false);
    expect(h.guardArmed()).toBe(true);
    expect(fs.existsSync(path.join(fixture.artifactsDir, "local", path.basename(planFilePath)))).toBe(true);
    expect(h.selects).toHaveLength(1);
    expect(h.notices.length).toBeGreaterThan(0);
    await h.transcript("show");
    expect(h.transcriptStatus()?.result).toEqual(result);
  });

  it.each(["execute", "refine", "dismiss"])("preserves existing %s verdict effects", async (verdict) => {
    const fixture = transcriptFixture();
    const selection = transcriptSelection(fixture);
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer(verdict);
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()).toMatchObject({ busy: false, result: { status: "settled" } });
    expect(h.referencePath()).toBe(verdict === "execute" ? `local://transcript-${selection.requestId}-plan.html` : null);
    expect(h.guardArmed()).toBe(verdict !== "execute");
    expect(h.status()?.approved).toBe(verdict === "execute");
    expect(exits(h.sent)).toHaveLength(verdict === "execute" ? 1 : 0);
  });

  it.each(["streaming", "source"])("keeps execute settled when follow-up %s activity starts during exit", async (kind) => {
    const fixture = transcriptFixture();
    let instructions = 0;
    fixture.onInstruction = () => {
      instructions += 1;
      if (instructions !== 2) return;
      if (kind === "streaming") fixture.streaming = true;
      else fixture.entries[1]!.message.content = "<html>Follow-up source</html>";
    };
    const selection = transcriptSelection(fixture);
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("execute");
    await adoptTranscript(h, selection);
    expect(instructions).toBe(2);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "settled", requestId: selection.requestId });
    expect(h.referencePath()).toBe(`local://transcript-${selection.requestId}-plan.html`);
    expect(h.status()?.approved).toBe(true);
    expect(h.guardArmed()).toBe(false);
  });

  it("checks identity again after the gate and never pins a copied plan onto a replacement session", async () => {
    const fixture = transcriptFixture();
    const h = harness(executableExtension(), { transcript: fixture, heldSelect: true });
    const adopting = adoptTranscript(h, transcriptSelection(fixture));
    await vi.waitFor(() => expect(h.selects).toHaveLength(1));
    fixture.sessionId = "replacement-session";
    h.release?.("execute");
    await adopting;
    expect(h.referencePath()).toBeNull();
    expect(h.status()?.approved).toBe(false);
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "source-changed" });
  });

  it("preserves receipts across branch and compaction events but clears them on actual identity change", async () => {
    const fixture = transcriptFixture();
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer("dismiss");
    await adoptTranscript(h, transcriptSelection(fixture));
    const result = h.transcriptStatus()?.result;
    await h.fire("session_branch");
    expect(h.transcriptStatus()?.result).toEqual(result);
    await h.fire("session_compact");
    expect(h.transcriptStatus()?.result).toEqual(result);
    fixture.sessionId = "new-session";
    await h.fire("session_switch");
    expect(h.transcriptStatus()).toMatchObject({ sessionId: "new-session", result: null });
  });

  it("reports a review that closed without a verdict as failure rather than settlement", async () => {
    const fixture = transcriptFixture();
    const h = harness(executableExtension(), { transcript: fixture });
    h.answer(undefined);
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()).toMatchObject({ busy: false, result: { status: "failed", code: "unavailable" } });
    expect(h.referencePath()).toBeNull();
    expect(h.status()?.approved).toBe(false);
    expect(h.guardArmed()).toBe(true);
  });

  it("completes short synchronous writes without changing the captured bytes", async () => {
    const fixture = transcriptFixture();
    const shortWrite = ((fd: number, buffer: Uint8Array, offset: number, length: number) =>
      fs.writeSync(fd, buffer, offset, Math.min(length, 7))) as typeof fs.writeSync;
    const h = harness(executableExtension({ writeSync: shortWrite }), { transcript: fixture });
    const selection = transcriptSelection(fixture);
    h.answer("dismiss");
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result?.status).toBe("settled");
    expect(fs.readFileSync(path.join(fixture.artifactsDir, "local", `transcript-${selection.requestId}-plan.html`), "utf8"))
      .toBe(fixture.entries[1]!.message.content);
  });

  it("canonicalizes a symlinked session directory while keeping artifacts within its real parent", async () => {
    const fixture = transcriptFixture();
    const canonical = fixture.sessionDir;
    const alias = path.join(tempLineage(), "session-link");
    fs.symlinkSync(canonical, alias);
    fixture.sessionDir = alias;
    fixture.artifactsDir = path.join(alias, "artifacts");
    const h = harness(executableExtension(), { transcript: fixture });
    const selection = transcriptSelection(fixture);
    h.answer("dismiss");
    await adoptTranscript(h, selection);
    expect(h.transcriptStatus()?.result?.status).toBe("settled");
    expect(fs.existsSync(path.join(canonical, "artifacts", "local", `transcript-${selection.requestId}-plan.html`))).toBe(true);
  });

  it("checks the byte limit rather than the UTF-16 length for multibyte source", async () => {
    const fixture = transcriptFixture("<html>" + "😀".repeat(PLAN_ARTIFACT_BYTE_LIMIT / 4) + "</html>");
    const h = harness(executableExtension(), { transcript: fixture });
    await adoptTranscript(h, transcriptSelection(fixture));
    expect(h.transcriptStatus()?.result).toMatchObject({ status: "failed", code: "over-limit" });
    expect(fs.existsSync(fixture.artifactsDir)).toBe(false);
    expect(h.selects).toEqual([]);
  });
});
