// The vibe command family in a native tab (issue #683): what the composer
// dispatches, how a snapshot's correlated result settles the row it belongs
// to, and which lines the bridge refuses instead of forwarding as prose.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { VIBE_COMMAND, VIBE_STATUS_KEY, type VibeSnapshot, type VibeWorker } from "@omp-ui/core/vibe";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

function vibeWorker(overrides: Partial<VibeWorker> = {}): VibeWorker {
  return {
    id: "FortunateBeetle",
    cli: "fast",
    state: "idle",
    killed: false,
    model: "openrouter/openai/gpt-5.6-luna",
    turns: 2,
    queued: 0,
    turnMessage: null,
    currentTool: null,
    lastIntent: "reading the store",
    createdAt: 1,
    ...overrides,
  };
}

function vibeSnapshot(overrides: Partial<VibeSnapshot> = {}): VibeSnapshot {
  return {
    version: 1,
    processKey: "proc-1",
    sessionId: "sess-1",
    revision: 1,
    available: true,
    unavailable: null,
    enabled: true,
    workers: [vibeWorker()],
    result: null,
    ...overrides,
  };
}

function publish(tabId: string, snapshot: VibeSnapshot | string): void {
  h.useStore.getState().handleRpcFrame(tabId, {
    type: "extension_ui_request",
    id: "frame-" + Math.random().toString(36).slice(2),
    method: "setStatus",
    statusKey: VIBE_STATUS_KEY,
    statusText: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
  });
}

/**
 * The hidden prompt frames this tab was asked to send, including the ones
 * `runLine` already answered: a dispatched line leaves the tab exactly once.
 */
function vibePrompts(): string[] {
  return allPrompts().filter((message) => message.startsWith(`/${VIBE_COMMAND} command `));
}

function allPrompts(): string[] {
  return h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message));
}

function commandRows(): Array<{ name: string; args: string; status: string; output?: string; error?: string }> {
  return (h.useStore.getState().rpc[h.TAB]?.items ?? [])
    .filter((item) => item.kind === "command")
    .map((item) =>
      item.kind === "command"
        ? { name: item.name, args: item.args, status: item.status, output: item.output, error: item.error }
        : null,
    )
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

/**
 * Runs a slash line and answers every rpc call it makes. `runSlashCommand`
 * resolves only when the prompt's response lands, so a test that asserts on what
 * left the tab must answer before it awaits.
 */
async function runLine(
  tabId: string,
  line: string,
  reply: unknown = { agentInvoked: false },
  success = true,
): Promise<void> {
  const promise = h.useStore.getState().runSlashCommand(tabId, line);
  // Answered in place, never drained: the frames a line produced are the
  // evidence the assertion reads.
  for (const { tabId: sentTab, cmd } of [...h.sent]) h.respond(sentTab, cmd, reply, success);
  await promise;
}

/** The requestId the dispatcher minted into one hidden prompt frame. */
function requestIdOf(cmd: Record<string, unknown>): string {
  const message = String(cmd.message ?? "");
  const json = message.slice(message.indexOf("command ") + "command ".length);
  return (JSON.parse(json) as { requestId: string }).requestId;
}

function decoded(): { command: string; args: string; sessionId: string; processKey: string } {
  return JSON.parse(
    vibePrompts().at(-1)!.slice(`/${VIBE_COMMAND} command `.length),
  ) as { command: string; args: string; sessionId: string; processKey: string };
}

/** A backend state whose one session reports `vibe`, for hydration cases. */
function summaryWithVibe(base: BackendState, vibe: VibeSnapshot): BackendState {
  return {
    ...base,
    projects: [
      {
        ...base.projects[0]!,
        sessions: [{ ...base.projects[0]!.sessions[0]!, tabId: h.TAB, vibe }],
      },
    ],
  };
}

describe("native vibe commands (issue #683)", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.sent.length = 0;
  });

  describe("the composer's slash interception", () => {
    beforeEach(() => {
      h.useStore.setState({
        state: h.backendState,
        tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
        rpc: { [h.TAB]: rpcTabState({ vibe: vibeSnapshot() }) },
      });
    });

    it("dispatches /vibe spawn as the hidden bridge command, never as prose", async () => {
      await runLine(h.TAB, "/vibe spawn fix the flaky test");
      expect(decoded()).toMatchObject({
        command: "spawn",
        args: JSON.stringify({ cli: "fast", prompt: "fix the flaky test" }),
        sessionId: "sess-1",
        processKey: "proc-1",
      });
      // Nothing else went to the model: no plain prompt carries the user's line.
      expect(allPrompts().filter((m) => m === "/vibe spawn fix the flaky test")).toEqual([]);
    });

    it("translates the tier and name flags into worker-tool args", async () => {
      await runLine(h.TAB, "/vibe spawn --good --name Inspector dig into the deadlock");
      expect(decoded().args).toBe(
        JSON.stringify({ cli: "good", prompt: "dig into the deadlock", name: "Inspector" }),
      );
    });

    it("maps a bare /vibe to the mode toggle and kill/send/kill to their tools", async () => {
      await runLine(h.TAB, "/vibe");
      expect(decoded()).toMatchObject({ command: "toggle", args: "" });
      await runLine(h.TAB, "/vibe off");
      expect(decoded()).toMatchObject({ command: "off", args: "" });
      await runLine(h.TAB, "/vibe send Inspector take the tests");
      expect(decoded().args).toBe(JSON.stringify({ session: "Inspector", message: "take the tests" }));
      await runLine(h.TAB, "/vibe kill Inspector");
      expect(decoded().args).toBe(JSON.stringify({ session: "Inspector" }));
      await runLine(h.TAB, "/vibe list");
      expect(decoded()).toMatchObject({ command: "list", args: "" });
    });

    it("leaves a terminal tab's vibe line to omp's own TUI", async () => {
      h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })] });
      await runLine(h.TAB, "/vibe list");
      expect(vibePrompts()).toEqual([]);
      expect(allPrompts()).toContain("/vibe list");
    });

    it("does not intercept a command that merely starts with the word vibe", async () => {
      await runLine(h.TAB, "/vibecheck status");
      expect(vibePrompts()).toEqual([]);
      expect(allPrompts()).toContain("/vibecheck status");
    });

    it("refuses an unsupported verb instead of letting prose reach the director", async () => {
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe scope main");
      expect(vibePrompts()).toEqual([]);
      expect(commandRows()[0]?.status).toBe("failed");
      expect(commandRows()[0]?.error ?? commandRows()[0]?.output).toContain("scope");
    });

    it("refuses a worker verb with an empty shape before the wire", async () => {
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe spawn");
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe send OnlyAName");
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe kill");
      expect(vibePrompts()).toEqual([]);
      expect(commandRows().map((row) => row.status)).toEqual(["failed", "failed", "failed"]);
    });

    it("answers with the bridge's reason and sends nothing when it is unavailable", async () => {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            vibe: vibeSnapshot({
              available: false,
              unavailable: "activateVibeTools is not a function",
              enabled: false,
              workers: [],
            }),
          }),
        },
      });
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe list");
      expect(vibePrompts()).toEqual([]);
      const [row] = commandRows();
      expect(row?.status).toBe("failed");
      expect(row?.error ?? row?.output).toContain("activateVibeTools is not a function");
    });

    it("says what an old live process needs when no bridge ever reported", async () => {
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ vibe: null }) } });
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe");
      expect(vibePrompts()).toEqual([]);
      const [row] = commandRows();
      expect(row?.status).toBe("failed");
      expect(row?.error ?? row?.output).toContain("restarting this live session");
    });

    it("keeps an over-budget prompt out of the wire entirely", async () => {
      await h.useStore.getState().runSlashCommand(h.TAB, "/vibe spawn " + "x".repeat(70_000));
      expect(vibePrompts()).toEqual([]);
      expect(commandRows()[0]?.status).toBe("failed");
    });
  });

  describe("command rows and correlated results", () => {
    /** Starts the line without answering; the case settles it in its own order. */
    const start = (line: string): Promise<void> => {
      h.useStore.setState({
        state: h.backendState,
        tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
        rpc: { [h.TAB]: rpcTabState({ vibe: vibeSnapshot() }) },
      });
      h.sent.length = 0;
      return h.useStore.getState().runSlashCommand(h.TAB, line);
    };

    const promptFrame = (): Record<string, unknown> => h.sent.at(-1)!.cmd;

    it("settles the row from the snapshot result when the result arrives first", async () => {
      const promise = start("/vibe list");
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(promptFrame()), ok: true, text: "1 worker: FortunateBeetle idle" },
        }),
      );
      expect(commandRows()[0]).toMatchObject({ name: "vibe", args: "list", status: "done" });
      expect(commandRows()[0]?.output).toBe("1 worker: FortunateBeetle idle");
      h.respond(h.TAB, promptFrame(), { agentInvoked: false });
      await promise;
      // A settled row is never re-decided by the acknowledgement that follows.
      expect(commandRows()[0]?.output).toBe("1 worker: FortunateBeetle idle");
    });

    it("settles the row when the acknowledgement arrives first", async () => {
      const promise = start("/vibe kill FortunateBeetle");
      const frame = promptFrame();
      h.respond(h.TAB, frame, { agentInvoked: false });
      await promise;
      // The acknowledgement alone must not claim an outcome the bridge has not
      // reported: the row waits for its result.
      expect(commandRows()[0]?.status).toBe("running");
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          workers: [],
          result: { requestId: requestIdOf(frame), ok: true, text: "Killed FortunateBeetle." },
        }),
      );
      expect(commandRows()[0]?.status).toBe("done");
    });

    it("settles a failed command result as failed", async () => {
      const promise = start("/vibe send Ghost hello");
      const frame = promptFrame();
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: false, text: "no worker named Ghost" },
        }),
      );
      expect(commandRows()[0]?.status).toBe("failed");
      h.respond(h.TAB, frame, { agentInvoked: false });
      await promise;
    });

    it("settles a lost rpc call as failed and drops the correlation", async () => {
      const promise = start("/vibe list");
      const frame = promptFrame();
      h.respond(h.TAB, frame, "child gone", false);
      await promise;
      expect(commandRows()[0]?.status).toBe("failed");
      // A late result for the abandoned request finds no row to settle.
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: true, text: "too late" },
        }),
      );
      expect(commandRows()[0]?.output).not.toBe("too late");
    });

    it("never lets another client's retained result settle this tab's row", async () => {
      const promise = start("/vibe wait");
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          result: { requestId: "someone-elses-request", ok: true, text: "answered elsewhere" },
        }),
      );
      expect(commandRows()[0]?.status).toBe("running");
      h.respond(h.TAB, promptFrame(), { agentInvoked: false });
      await promise;
    });

    it("drops pending correlations when the process is torn down", async () => {
      const promise = start("/vibe list");
      const frame = promptFrame();
      // The renderer's real process-death signal.
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "child died" });
      await promise;
      expect(commandRows()[0]?.status).toBe("failed");
      publish(
        h.TAB,
        vibeSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: true, text: "late" },
        }),
      );
      expect(commandRows()[0]?.output).not.toBe("late");
    });
  });

  describe("snapshot acceptance", () => {
    beforeEach(() => {
      h.useStore.setState({
        state: h.backendState,
        rpc: { [h.TAB]: rpcTabState({ vibe: vibeSnapshot({ revision: 5 }) }) },
      });
    });

    it("rejects an older revision from the same bridge", () => {
      publish(h.TAB, vibeSnapshot({ revision: 4, enabled: false, workers: [] }));
      expect(h.useStore.getState().rpc[h.TAB]?.vibe?.revision).toBe(5);
      expect(h.useStore.getState().rpc[h.TAB]?.vibe?.workers[0]?.id).toBe("FortunateBeetle");
    });

    it("accepts a replacement bridge's first revision", () => {
      publish(
        h.TAB,
        vibeSnapshot({ processKey: "proc-2", revision: 1, workers: [vibeWorker({ id: "BraveOtter" })] }),
      );
      const vibe = h.useStore.getState().rpc[h.TAB]?.vibe;
      expect(vibe?.processKey).toBe("proc-2");
      expect(vibe?.workers[0]?.id).toBe("BraveOtter");
    });

    it("keeps the last real roster when a publish is malformed", () => {
      publish(h.TAB, "{ not json");
      expect(h.useStore.getState().rpc[h.TAB]?.vibe?.revision).toBe(5);
    });

    it("hydrates a late-joining renderer from the summary alone", async () => {
      // A fresh store module per case: init latches once per module evaluation,
      // so the real onStateChanged handler can only be captured this way.
      vi.resetModules();
      const { useStore: fresh } = await import("../../store");
      const init = fresh.getState().init();
      const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
        state: BackendState,
      ) => void;
      await init;
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ vibe: vibeSnapshot({ revision: 9 }) }) } });
      const base = h.stateWithRecord("sess-1");

      // Older than what the tab already holds: the summary cannot roll it back.
      onStateChanged(summaryWithVibe(base, vibeSnapshot({ revision: 3, enabled: false, workers: [] })));
      expect(fresh.getState().rpc[h.TAB]?.vibe?.revision).toBe(9);

      // A newer process's report wins outright.
      onStateChanged(summaryWithVibe(base, vibeSnapshot({ processKey: "proc-9", revision: 1 })));
      expect(fresh.getState().rpc[h.TAB]?.vibe?.processKey).toBe("proc-9");
    });

    it("claims the vibe channel ahead of the generic extension status", () => {
      publish(h.TAB, vibeSnapshot({ revision: 6 }));
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.vibe?.revision).toBe(6);
      // The HUD's status chips render unclaimed extension status; a vibe publish
      // is state, so it must never surface there as a chip.
      expect(Object.keys(tab.extensionStatus ?? {})).not.toContain("omp-ui:vibe");
    });

    it("clears a vibe mode no live process reports anymore", async () => {
      // A fresh store module per case, as in the hydration case above: init
      // latches once per module evaluation.
      vi.resetModules();
      const { useStore: fresh } = await import("../../store");
      const init = fresh.getState().init();
      const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
        state: BackendState,
      ) => void;
      await init;
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ vibe: vibeSnapshot() }) } });
      const base = h.stateWithRecord("sess-1");
      const dormant = {
        ...base,
        projects: [
          {
            ...base.projects[0]!,
            sessions: [{ ...base.projects[0]!.sessions[0]!, tabId: h.TAB, live: "dormant" as const }],
          },
        ],
      };
      onStateChanged(dormant);
      expect(fresh.getState().rpc[h.TAB]?.vibe).toBeNull();
    });
  });
});
