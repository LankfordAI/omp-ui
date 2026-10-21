import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASK_CONTEXT_CUSTOM_TYPE,
  CARRYOVER_CONTEXT_CHAR_MAX,
  CARRYOVER_CONTEXT_CUSTOM_TYPE,
  RpcClient,
  askContextArmMessage,
  carryoverContextArmMessage,
  renderCarryoverDigest,
  resolveOmpBinary,
  writeAskContextExtension,
  writeCarryoverContextExtension,
} from "@omp-ui/core";

/**
 * Live proof for the generated hidden-context bridges (ADR-0060) against the
 * real `omp --mode=rpc-ui` binary — the Ask chat pinned context (#895) and
 * the restart carryover seed (#896). Same skip-when-no-binary discipline as
 * private-guard-live.test.ts. Model-free: the arm is an extension slash
 * command, so omp settles it without invoking the agent, and `get_messages`
 * reads back what the session will hand the model.
 *
 * The claims are the ones a consumer would notice if they broke:
 * 1. A fresh spawn armed the shipped way carries exactly ONE hidden pinned
 *    message, with no warning toast and no agent turn.
 * 2. A resumed transcript that already holds the pin never stacks a second
 *    copy on re-arm — the original snapshot stays the only one.
 * 3. A compaction boundary after the pin makes the re-arm send it again, so
 *    the model never loses the context it was promised.
 * 4. The carryover digest rides as a hidden message and leaves the user's
 *    APPEND_SYSTEM.md in the system prompt (the #824 seed replaced it).
 * 5. A carryover digest at its 64 KiB ceiling crosses the real NDJSON
 *    transport and slash dispatch intact.
 *
 * Transcripts for (2) and (3) are hand-written in omp's v3 session format
 * (header + parentId-chained entries, the shape omp itself writes): only a
 * model turn could persist them otherwise. HOME/XDG point at the temp scope.
 * Real timers throughout: the awaited actor is an OS process speaking NDJSON,
 * which no fake clock can advance; every wait ends on an observed frame.
 */

const ompPath = resolveOmpBinary();
const ARM_ID = "ask-arm";
const MESSAGES_ID = "ask-messages";
const ARM_TEXT = "probe ask context text";

interface Frame {
  type: string;
  id?: string;
  method?: string;
  success?: boolean;
  agentInvoked?: boolean;
  status?: string;
  data?: { messages?: TranscriptMessage[]; systemPrompt?: unknown };
  message?: { role?: string };
}

interface TranscriptMessage {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

/** A v3 omp transcript entry list, written where `--session-dir` + `--resume` find it. */
function seedTranscript(lineage: string, sessionId: string, entries: object[]): void {
  const ts = "2026-10-20T12:00:00.000Z";
  const header = { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: lineage };
  const lines = [header, ...entries.map((entry) => ({ timestamp: ts, ...entry }))];
  fs.writeFileSync(
    path.join(lineage, `2026-10-20T12-00-00-000Z_${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

function userEntry(id: string, parentId: string | null, text: string): object {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: 1_792_500_000_000 },
  };
}

function pinEntry(id: string, parentId: string, content: string): object {
  return {
    type: "custom_message",
    customType: ASK_CONTEXT_CUSTOM_TYPE,
    content,
    display: false,
    attribution: "agent",
    id,
    parentId,
  };
}

interface SpawnOptions {
  /** Writes the bridge into the lineage dir and returns its path. */
  extension: (lineage: string) => string;
  /** The arm prompt sent through initialCommands. */
  arm: string;
  seed?: { sessionId: string; entries: object[] };
  /** Paths relative to the project dir, written before spawn. */
  projectFiles?: Record<string, string>;
}

/** Spawns omp with one hidden-context bridge, armed through initialCommands as the spawner does. */
function spawnScope(opts: SpawnOptions): Scope {
  const { seed } = opts;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-hiddenlive-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const [rel, content] of Object.entries(opts.projectFiles ?? {})) {
    const file = path.join(project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  if (seed) seedTranscript(lineage, seed.sessionId, seed.entries);
  const extension = opts.extension(lineage);
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    ...(seed ? { resumeSessionId: seed.sessionId } : {}),
    extensions: [extension],
    initialCommands: [{ type: "prompt", message: opts.arm, id: ARM_ID }],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
      });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: () => {},
  });
  return { base, frames, client, exited };
}

/** Waits for the arm to settle, then reads the session's model-facing messages. */
async function messagesAfterArm(scope: Scope): Promise<TranscriptMessage[]> {
  const settled = await waitFor(
    () => scope.frames.find((f) => f.type === "prompt_result" && f.id === ARM_ID),
    60_000,
    "the arm command's prompt_result",
  );
  expect(settled).toMatchObject({ status: "completed", agentInvoked: false });
  scope.client.send({ type: "get_messages", id: MESSAGES_ID });
  const response = await waitFor(
    () => scope.frames.find((f) => f.type === "response" && f.id === MESSAGES_ID),
    30_000,
    "the get_messages response",
  );
  expect(response.success).toBe(true);
  return response.data?.messages ?? [];
}

function pins(messages: TranscriptMessage[], customType = ASK_CONTEXT_CUSTOM_TYPE): TranscriptMessage[] {
  return messages.filter((m) => m.role === "custom" && m.customType === customType);
}

/** No warning toast, no rpc failure, no agent turn: the arm stays invisible. */
function expectQuietArm(scope: Scope): void {
  expect(scope.frames.filter((f) => f.type === "extension_ui_request" && f.method === "notify")).toEqual([]);
  expect(scope.frames.filter((f) => f.type === "response" && f.success === false)).toEqual([]);
  expect(scope.frames.filter((f) => f.type === "agent_start")).toEqual([]);
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function track(scope: Scope): Scope {
  disposers.push(async () => {
    scope.client.kill();
    const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
    if (!exitedNow) scope.client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return scope;
}

const askArm = { extension: writeAskContextExtension, arm: askContextArmMessage(ARM_TEXT) };

describe.skipIf(ompPath === null)("Ask chat pinned context on the real runtime", () => {
  it("a fresh arm pins exactly one hidden message", { timeout: 120_000 }, async () => {
    const scope = track(spawnScope(askArm));
    const messages = await messagesAfterArm(scope);
    expect(pins(messages)).toEqual([
      expect.objectContaining({ content: ARM_TEXT, display: false }),
    ]);
    // Hidden context, not a user turn: nothing else enters the transcript.
    expect(messages).toHaveLength(1);
    expectQuietArm(scope);
  });

  it("re-arming a resumed transcript that holds the pin adds no second copy", { timeout: 120_000 }, async () => {
    const sessionId = "019faa64-fdcd-7000-acfd-0123456789ab";
    const scope = track(
      spawnScope({
        ...askArm,
        seed: {
          sessionId,
          entries: [userEntry("a1b2c3d4", null, "hello"), pinEntry("e5f6a7b8", "a1b2c3d4", "earlier pinned text")],
        },
      }),
    );
    const messages = await messagesAfterArm(scope);
    // The snapshot pinned at creation stays the only copy; a re-rendered
    // text never stacks beside it.
    expect(pins(messages)).toEqual([expect.objectContaining({ content: "earlier pinned text" })]);
    expectQuietArm(scope);
  });

  it("a compaction after the pin makes the re-arm pin it again", { timeout: 120_000 }, async () => {
    const sessionId = "019faa64-fdcd-7000-acfd-0123456789ac";
    const scope = track(
      spawnScope({
        ...askArm,
        seed: {
          sessionId,
          entries: [
            userEntry("a1b2c3d4", null, "hello"),
            pinEntry("e5f6a7b8", "a1b2c3d4", "earlier pinned text"),
            userEntry("c9d0e1f2", "e5f6a7b8", "second"),
            {
              type: "compaction",
              id: "0a1b2c3d",
              parentId: "c9d0e1f2",
              summary: "summary of the earlier turns",
              shortSummary: "earlier turns",
              firstKeptEntryId: "c9d0e1f2",
              tokensBefore: 100,
              tokensAfter: 50,
              method: "soft",
              fromExtension: false,
              details: { readFiles: [], modifiedFiles: [] },
            },
          ],
        },
      }),
    );
    const messages = await messagesAfterArm(scope);
    // The pre-compaction pin was summarised away; the model must see the
    // pinned context again, once, after the boundary.
    expect(pins(messages)).toEqual([expect.objectContaining({ content: ARM_TEXT, display: false })]);
    expect(messages.at(-1)).toMatchObject({ role: "custom", customType: ASK_CONTEXT_CUSTOM_TYPE });
    expectQuietArm(scope);
  });
});

describe.skipIf(ompPath === null)("Restart carryover on the real runtime (#896)", () => {
  it("keeps the user's APPEND_SYSTEM.md and pins the digest once as a hidden message", { timeout: 120_000 }, async () => {
    const digest = renderCarryoverDigest([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
    const scope = track(
      spawnScope({
        extension: writeCarryoverContextExtension,
        arm: carryoverContextArmMessage(digest),
        // HOME is the temp scope, so only this project file can supply the marker.
        projectFiles: { ".omp/APPEND_SYSTEM.md": "APPENDSYS-MARKER-896\n" },
      }),
    );
    const messages = await messagesAfterArm(scope);
    expect(pins(messages, CARRYOVER_CONTEXT_CUSTOM_TYPE)).toEqual([
      expect.objectContaining({ content: digest, display: false }),
    ]);
    expect(messages).toHaveLength(1);
    expectQuietArm(scope);

    scope.client.send({ type: "get_state", id: "state" });
    const state = await waitFor(
      () => scope.frames.find((f) => f.type === "response" && f.id === "state"),
      30_000,
      "the get_state response",
    );
    expect(state.success).toBe(true);
    // The #824 seed rode --append-system-prompt, which replaced this file.
    expect((state.data?.systemPrompt as string[]).join("\n")).toContain("APPENDSYS-MARKER-896");
  });

  it("arms a digest at the ceiling intact", { timeout: 120_000 }, async () => {
    const text = "x".repeat(CARRYOVER_CONTEXT_CHAR_MAX);
    const scope = track(
      spawnScope({ extension: writeCarryoverContextExtension, arm: carryoverContextArmMessage(text) }),
    );
    const messages = await messagesAfterArm(scope);
    const pinned = pins(messages, CARRYOVER_CONTEXT_CUSTOM_TYPE);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.content).toBe(text);
    expectQuietArm(scope);
  });
});
