import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_CONTEXT_COMMAND,
  ASK_CONTEXT_CUSTOM_TYPE,
  ASK_CONTEXT_TEXT_MAX,
  askContextArmMessage,
  askContextArtifactPath,
  askContextExtensionPath,
  askContextText,
  readAskContext,
  stageAskContext,
  writeAskContextExtension,
} from "./ask-context";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";
import { bound, hiddenContextHarness, type HiddenContextEntry } from "./hidden-context-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ask-context-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const TRANSCRIPT = "/home/u/.omp/agent/sessions/omp-ui--proj--tab/2026-10-20_019faeab.jsonl";
const PINNED = "pinned summary of the source session";

/** The `set <json>` argument string the spawner's arming command carries. */
function setArgs(text: string): string {
  return askContextArmMessage(text).slice(`/${ASK_CONTEXT_COMMAND} `.length);
}

// ------------------------------------------------------------------ fixtures

const PINNED_ENTRY: HiddenContextEntry = { type: "custom_message", customType: ASK_CONTEXT_CUSTOM_TYPE };

function harness(o: { canSendMessages?: boolean } = {}) {
  return hiddenContextHarness({
    write: writeAskContextExtension,
    command: ASK_CONTEXT_COMMAND,
    lineageDir: tempLineage(),
    ...o,
  });
}

// ------------------------------------------------------------------- tests

describe("askContextText", () => {
  it("carries the summary, the source session id, and the read-only seance route", () => {
    const text = askContextText({ sessionId: SESSION_ID, summary: `  ${PINNED}\n`, transcriptPath: TRANSCRIPT });
    expect(text).toContain(`${PINNED}\n\nAnswer questions`);
    expect(text).toContain(`omp-ui://sessions/${SESSION_ID}/summary`);
    expect(text).toContain(`sourceSession "${TRANSCRIPT}"`);
    expect(text).toContain(`/seance ${SESSION_ID}`);
    expect(text.length).toBeLessThanOrEqual(ASK_CONTEXT_TEXT_MAX);
  });

  // Two parities so one of them lands the cut on a surrogate pair.
  it.each([
    ["an ASCII summary", "a".repeat(20_000)],
    ["an emoji summary", "😀".repeat(10_000)],
    ["an offset emoji summary", `a${"😀".repeat(10_000)}`],
  ])("shrinks only the summary of %s to fit the cap", (_label, summary) => {
    const text = askContextText({ sessionId: SESSION_ID, summary, transcriptPath: TRANSCRIPT });
    expect(text.length).toBeLessThanOrEqual(ASK_CONTEXT_TEXT_MAX);
    expect(text.length).toBeGreaterThan(ASK_CONTEXT_TEXT_MAX - 2);
    expect(text).toContain(`…\n\nAnswer questions about that session`);
    expect(text).toContain(`sourceSession "${TRANSCRIPT}"`);
    expect(text).toContain(`session id ${SESSION_ID}`);
    // No high surrogate left without its low half.
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("staged ask context", () => {
  it("reads null when nothing is staged", () => {
    expect(readAskContext(tempLineage())).toBeNull();
  });

  it("reads null for a blank artifact", () => {
    const lineage = tempLineage();
    fs.writeFileSync(askContextArtifactPath(lineage), "  \n\t\n", "utf8");
    expect(readAskContext(lineage)).toBeNull();
  });

  it("reads back the staged text into a not-yet-existing lineage dir", () => {
    const lineage = path.join(tempLineage(), "nested");
    stageAskContext(lineage, PINNED);
    expect(readAskContext(lineage)).toBe(PINNED);
  });
});

describe("writeAskContextExtension", () => {
  it("writes into the lineage dir, overwrites a stale copy, and strictly typechecks", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeAskContextExtension(lineage);
    expect(file).toBe(askContextExtensionPath(lineage));
    expect(path.basename(file)).toBe("omp-ui-ask-context.ts");
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeAskContextExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).not.toBe("// stale\n");
    typecheckGeneratedExtension(file);
  });
});

describe("pinned context delivery", () => {
  it("delivers the armed text once as a hidden message for the next turn", async () => {
    const h = harness();
    await bound(h);
    const text = askContextText({ sessionId: SESSION_ID, summary: PINNED, transcriptPath: TRANSCRIPT });
    await h.invoke(setArgs(text));
    expect(h.sent).toEqual([
      {
        msg: { customType: ASK_CONTEXT_CUSTOM_TYPE, content: text, display: false, attribution: "agent" },
        opts: { deliverAs: "nextTurn", triggerTurn: false },
      },
    ]);
    expect(h.notices).toEqual([]);
  });

  it("skips a resumed chat whose branch already holds the pinned message", async () => {
    const h = harness();
    await bound(h);
    h.branch.push({ type: "message" }, PINNED_ENTRY, { type: "message" }, { type: "custom_message", customType: "other" });
    await h.invoke(setArgs(PINNED));
    expect(h.sent).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("re-sends after a compaction that sits after the pinned message, but not before one", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(PINNED));
    h.branch.push(PINNED_ENTRY, { type: "message" });
    await h.fire("session_compact");
    expect(h.sent).toHaveLength(1);
    h.branch.push({ type: "compaction" });
    await h.fire("session_compact");
    expect(h.sent.map((s) => s.msg.content)).toEqual([PINNED, PINNED]);
  });

  it("re-sends after a reset boundary that sits after the pinned message", async () => {
    const h = harness();
    await bound(h);
    h.branch.push(PINNED_ENTRY, { type: "reset_boundary" });
    await h.invoke(setArgs(PINNED));
    expect(h.sent).toHaveLength(1);
  });

  it("skips a branch whose path still holds the pinned message", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(PINNED));
    h.branch.push(PINNED_ENTRY, { type: "message" });
    await h.fire("session_branch");
    expect(h.sent).toHaveLength(1);
  });

  it("re-sends on a branch whose path no longer holds the pinned message", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(PINNED));
    h.branch.push({ type: "message" });
    await h.fire("session_branch");
    expect(h.sent.map((s) => s.msg.content)).toEqual([PINNED, PINNED]);
  });

  it("sends nothing on a session event before any set", async () => {
    const h = harness();
    await bound(h);
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
  });

  it("steers a streaming root instead of waiting for the next turn", async () => {
    const h = harness();
    const root = await bound(h);
    root.isStreaming = true;
    await h.invoke(setArgs(PINNED));
    expect(h.sent.map((s) => s.opts)).toEqual([{ deliverAs: "steer", triggerTurn: false }]);
  });
});

describe("refusals", () => {
  it.each([
    ["bad JSON", "set {text:", "omp-ui ask context: malformed context"],
    ["an extra key", `set ${JSON.stringify({ text: PINNED, extra: true })}`, "omp-ui ask context: malformed context"],
    ["empty text", `set ${JSON.stringify({ text: "" })}`, "omp-ui ask context: malformed context"],
    [
      "text over the cap",
      `set ${JSON.stringify({ text: "a".repeat(ASK_CONTEXT_TEXT_MAX + 1) })}`,
      "omp-ui ask context: malformed context",
    ],
    ["an unknown verb", "clear", "omp-ui ask context: unknown command"],
  ])("warns and sends nothing for %s", async (_label, args, message) => {
    const h = harness();
    await bound(h);
    await h.invoke(args);
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
    expect(h.notices).toEqual([{ message, level: "warning" }]);
  });

  it("warns once when the root cannot carry custom messages", async () => {
    const h = harness({ canSendMessages: false });
    await bound(h);
    await h.invoke(setArgs(PINNED));
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
    expect(h.notices).toEqual([
      { message: "omp-ui ask context: this omp cannot carry the pinned context to the agent", level: "warning" },
    ]);
  });
});
