import * as fs from "node:fs";
import { expect } from "vitest";
import { transpileGeneratedExtension } from "./generated-extension-test-utils";

/** One `sendCustomMessage` call the generated bridge made. */
export interface HiddenContextSent {
  msg: { customType: string; content: string; display: boolean; attribution: string };
  opts: { deliverAs: string; triggerTurn: boolean };
}

/** One entry of the fake session tree; only type/customType are read. */
export type HiddenContextEntry = { type: string; customType?: string };

export interface HiddenContextSession {
  isStreaming: boolean;
  prompt(text: string): Promise<void>;
}

export interface HiddenContextHarness {
  AgentSession: new () => HiddenContextSession;
  /** The root's current branch as omp's sessionManager.getBranch() returns it. */
  branch: HiddenContextEntry[];
  invoke(args: string): Promise<void>;
  fire(event: string): Promise<void>;
  sent: HiddenContextSent[];
  notices: { message: string; level: string | undefined }[];
}

/** Transpiles a generated hidden context bridge and instantiates it against a fake omp surface. */
export function hiddenContextHarness(opts: {
  write: (lineageDir: string) => string;
  command: string;
  lineageDir: string;
  canSendMessages?: boolean;
}): HiddenContextHarness {
  const file = opts.write(opts.lineageDir);
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error(`generated ${opts.command} extension has no default factory`);

  const sent: HiddenContextSent[] = [];
  const notices: HiddenContextHarness["notices"] = [];
  const branch: HiddenContextEntry[] = [];
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  class FakeAgentSession implements HiddenContextSession {
    isStreaming = false;
    sessionManager = { getBranch: (): HiddenContextEntry[] => branch };
    async prompt(): Promise<void> {}
  }
  if (opts.canSendMessages !== false) {
    Object.defineProperty(FakeAgentSession.prototype, "sendCustomMessage", {
      value: async (msg: HiddenContextSent["msg"], sendOpts: HiddenContextSent["opts"]): Promise<void> => {
        sent.push({ msg, opts: sendOpts });
      },
    });
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(opts.command);
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
    branch,
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
export async function bound(h: HiddenContextHarness): Promise<HiddenContextSession> {
  const root = new h.AgentSession();
  await root.prompt("hello");
  return root;
}
