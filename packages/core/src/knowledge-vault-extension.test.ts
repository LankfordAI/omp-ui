import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";
import {
  KNOWLEDGE_VAULT_COMMAND,
  KNOWLEDGE_VAULT_CUSTOM_TYPE,
  KNOWLEDGE_VAULT_TEXT_MAX,
  knowledgeVaultArmMessage,
  knowledgeVaultExtensionPath,
  knowledgeVaultGuidance,
  writeKnowledgeVaultExtension,
} from "./knowledge-vault-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-knowledge-vault-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const WRITE_NOTES = `omp-ui connected this session to the user's Obsidian vault "Notes". The omp-ui_vault_* tools read the whole vault and write only inside its omp-ui home folder. Search before you write, to skip duplicates and to find the user's own notes worth linking. Write a vault note when a decision settles, at that moment, not at the end of the session. Also write one whenever you learn a lesson worth keeping: a wrong assumption, a trap, a fix that took several tries. Write-ups, and anything the user asks you to record, belong there too. One note per topic: a Title Case title and a plain markdown body; omp-ui adds the frontmatter and the index link. Link the user's notes as [[Title]] and omp-ui notes with the link the tool returns. Summarize and link the user's own notes; quote them only when the user asks, and only into vault notes. Never write secrets, tokens, or raw transcripts.`;
const BOTH_SUFFIX =
  "This project also keeps decisions in its repo docs/: write the full note there with your file tools, then create a short vault note with the title, a one-line gist, and the repo path.";

const TEXT_A = "guidance A";
const TEXT_B = "guidance B";

/** The `set <json>` argument string the spawner's hidden message carries. */
function setArgs(text: string): string {
  return knowledgeVaultArmMessage(text).slice(`/${KNOWLEDGE_VAULT_COMMAND} `.length);
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
  const file = writeKnowledgeVaultExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated knowledge vault extension has no default factory");

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
      expect(name).toBe(KNOWLEDGE_VAULT_COMMAND);
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

describe("writeKnowledgeVaultExtension", () => {
  it("writes into the lineage dir, overwrites a stale copy, and strictly typechecks", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeKnowledgeVaultExtension(lineage);
    expect(file).toBe(knowledgeVaultExtensionPath(lineage));
    expect(path.basename(file)).toBe("omp-ui-knowledge-vault.ts");
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeKnowledgeVaultExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).not.toBe("// stale\n");
    typecheckGeneratedExtension(file);
  });
});

describe("knowledgeVaultGuidance", () => {
  it("is exactly the write part, naming the vault, for a vault home", () => {
    expect(knowledgeVaultGuidance({ write: { vault: "Notes", both: false } })).toBe(WRITE_NOTES);
  });

  it("appends the repo-docs suffix after one space for both", () => {
    expect(knowledgeVaultGuidance({ write: { vault: "Notes", both: true } })).toBe(`${WRITE_NOTES} ${BOTH_SUFFIX}`);
  });

  it("is null when nothing touches a vault", () => {
    expect(knowledgeVaultGuidance({ write: null })).toBeNull();
  });

  it("never names plan mode", () => {
    for (const both of [false, true]) {
      expect(knowledgeVaultGuidance({ write: { vault: "Notes", both } })).not.toMatch(/plan/i);
    }
  });
});

describe("guidance delivery", () => {
  it("round-trips the arm message into one hidden message for the next turn when idle", async () => {
    const guidance = knowledgeVaultGuidance({ write: { vault: "Notes", both: true } })!;
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(guidance));
    expect(h.sent).toHaveLength(1);
    const [{ msg, opts }] = h.sent;
    expect(msg).toEqual({
      customType: KNOWLEDGE_VAULT_CUSTOM_TYPE,
      content: guidance,
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
    await h.invoke(setArgs(TEXT_A));
    expect(h.sent.map((s) => s.opts.deliverAs)).toEqual(["steer"]);
  });

  it("skips repeated guidance and delivers changed guidance", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs(TEXT_A));
    await h.invoke(setArgs(TEXT_A));
    expect(h.sent).toHaveLength(1);
    await h.invoke(setArgs(TEXT_B));
    expect(h.sent.map((s) => s.msg.content)).toEqual([TEXT_A, TEXT_B]);
  });

  it.each(["session_compact", "session_branch", "session_switch"])(
    "re-delivers the armed guidance after %s",
    async (event) => {
      const h = harness();
      await bound(h);
      await h.invoke(setArgs(TEXT_A));
      await h.fire(event);
      expect(h.sent.map((s) => s.msg.content)).toEqual([TEXT_A, TEXT_A]);
    },
  );

  it("sends nothing on a session event before any set", async () => {
    const h = harness();
    await bound(h);
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
  });

  it("retries the same guidance after a rejected delivery", async () => {
    const h = harness();
    const root = await bound(h);
    root.rejectNext = true;
    await h.invoke(setArgs(TEXT_A));
    expect(h.sent).toHaveLength(0);
    await h.invoke(setArgs(TEXT_A));
    expect(h.sent).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });

  it("accepts guidance at exactly the length cap", async () => {
    const h = harness();
    await bound(h);
    await h.invoke(setArgs("a".repeat(KNOWLEDGE_VAULT_TEXT_MAX)));
    expect(h.sent).toHaveLength(1);
    expect(h.notices).toEqual([]);
  });
});

describe("refusals", () => {
  it.each([
    ["bad JSON", "set {text:", "omp-ui knowledge vault: malformed guidance"],
    ["an extra key", `set ${JSON.stringify({ text: TEXT_A, extra: true })}`, "omp-ui knowledge vault: malformed guidance"],
    ["empty text", `set ${JSON.stringify({ text: "" })}`, "omp-ui knowledge vault: malformed guidance"],
    [
      "text over the cap",
      `set ${JSON.stringify({ text: "a".repeat(KNOWLEDGE_VAULT_TEXT_MAX + 1) })}`,
      "omp-ui knowledge vault: malformed guidance",
    ],
    ["an unknown verb", "clear", "omp-ui knowledge vault: unknown command"],
  ])("warns and sends nothing for %s", async (_label, args, message) => {
    const h = harness();
    await bound(h);
    await h.invoke(args);
    expect(h.sent).toEqual([]);
    expect(h.notices).toEqual([{ message, level: "warning" }]);
    // A later valid set is unaffected.
    await h.invoke(setArgs(TEXT_A));
    expect(h.sent).toHaveLength(1);
  });

  it("warns once per process when the root cannot carry custom messages", async () => {
    const h = harness({ canSendMessages: false });
    await bound(h);
    await h.invoke(setArgs(TEXT_A));
    await h.invoke(setArgs(TEXT_B));
    await h.fire("session_compact");
    expect(h.sent).toEqual([]);
    expect(h.notices).toEqual([
      { message: "omp-ui knowledge vault: this omp cannot carry the guidance to the agent", level: "warning" },
    ]);
  });
});
