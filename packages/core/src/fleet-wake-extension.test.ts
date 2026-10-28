import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLEET_WAKE_COMMAND,
  FLEET_WAKE_CUSTOM_TYPE,
  FLEET_WAKE_STATUS_KEY,
  fleetWakeArmMessage,
  type FleetWakeCard,
  type FleetWakeMessage,
} from "./fleet-wake";
import { fleetWakeExtensionPath, writeFleetWakeExtension } from "./fleet-wake-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-fleet-wake-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Sent {
  msg: { customType: string; content: string; display: boolean; attribution: string; details: { wakeId: string } };
  opts: { deliverAs: string; triggerTurn: boolean };
}
type Entry = { type: string; customType?: string; details?: unknown };

/** Transpiles the generated bridge against a fake omp surface (modeled on hidden-context-test-utils). */
function harness() {
  const file = writeFleetWakeExtension(tempLineage());
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated fleet-wake extension has no default factory");

  const sent: Sent[] = [];
  const notices: { message: string; level: string | undefined }[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  const branch: Entry[] = [];
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  class FakeAgentSession {
    isStreaming = false;
    sessionManager = { getBranch: (): Entry[] => branch };
    async prompt(): Promise<void> {}
    async sendCustomMessage(msg: Sent["msg"], opts: Sent["opts"]): Promise<void> {
      sent.push({ msg, opts });
    }
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(FLEET_WAKE_COMMAND);
      handler = options.handler;
    },
  });

  const ctx = {
    ui: {
      notify: (message: string, level?: string): void => {
        notices.push({ message, level });
      },
      setStatus: (key: string, text: string | undefined): void => {
        statuses.push({ key, text });
      },
    },
  };

  return {
    branch,
    sent,
    notices,
    statuses,
    async root(): Promise<FakeAgentSession> {
      const root = new FakeAgentSession();
      await root.prompt();
      return root;
    },
    async invoke(args: string): Promise<void> {
      if (!handler) throw new Error("generated extension registered no command");
      await handler(args, ctx);
    },
  };
}

const card: FleetWakeCard = {
  wakeId: "d1.result",
  dispatchId: "d1",
  kind: "result",
  title: "Fix the build",
  machine: "this computer",
  childTabId: "tab-1",
  outcome: "complete",
};
const message: FleetWakeMessage = { card, text: "Fleet result — done." };

/** The argument string the arming slash command carries. */
function deliverArgs(msg: FleetWakeMessage): string {
  return fleetWakeArmMessage(msg).slice(`/${FLEET_WAKE_COMMAND} `.length);
}

describe("writeFleetWakeExtension", () => {
  it("writes into the lineage dir and strictly typechecks", () => {
    const lineage = tempLineage();
    const file = writeFleetWakeExtension(lineage);
    expect(file).toBe(fleetWakeExtensionPath(lineage));
    expect(path.basename(file)).toBe("omp-ui-fleet-wake.ts");
    typecheckGeneratedExtension(file);
  });
});

describe("fleet wake bridge", () => {
  it("delivers a visible message that starts a turn on an idle root", async () => {
    const h = harness();
    await h.root();
    await h.invoke(deliverArgs(message));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].msg).toMatchObject({ customType: FLEET_WAKE_CUSTOM_TYPE, content: message.text, display: true });
    expect(h.sent[0].msg.details.wakeId).toBe("d1.result");
    expect(h.sent[0].opts).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
  });

  it("queues as a followUp while the root streams", async () => {
    const h = harness();
    const root = await h.root();
    root.isStreaming = true;
    await h.invoke(deliverArgs(message));
    expect(h.sent.map((s) => s.opts)).toEqual([{ deliverAs: "followUp", triggerTurn: true }]);
  });

  it("acknowledges instead of sending when the branch already holds the wake, even before a compaction", async () => {
    const h = harness();
    await h.root();
    h.branch.push(
      { type: "custom_message", customType: FLEET_WAKE_CUSTOM_TYPE, details: card },
      { type: "compaction" },
    );
    await h.invoke(deliverArgs(message));
    expect(h.sent).toHaveLength(0);
    expect(h.statuses).toEqual([{ key: FLEET_WAKE_STATUS_KEY, text: JSON.stringify({ wakeId: "d1.result" }) }]);
  });

  it("sends one message when the same id is armed twice in one process", async () => {
    const h = harness();
    await h.root();
    await h.invoke(deliverArgs(message));
    await h.invoke(deliverArgs(message));
    expect(h.sent).toHaveLength(1);
    expect(h.statuses).toHaveLength(0);
  });

  it("warns on a malformed payload and sends nothing", async () => {
    const h = harness();
    await h.root();
    await h.invoke(`deliver ${JSON.stringify({ text: "x", card: { ...card, wakeId: "bad id" } })}`);
    await h.invoke(`deliver ${JSON.stringify({ text: "", card })}`);
    await h.invoke(`deliver ${JSON.stringify({ text: "x", card, extra: 1 })}`);
    expect(h.sent).toHaveLength(0);
    expect(h.notices).toEqual(
      Array.from({ length: 3 }, () => ({ message: "omp-ui fleet wake: malformed message", level: "warning" })),
    );
  });
});
