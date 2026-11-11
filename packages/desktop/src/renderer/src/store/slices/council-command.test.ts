// Native /council dispatch follows the session process, not current Settings.
// Every preflight refusal stays local; only a ready, advertised bridge runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilInitializationStage, CouncilMember, SessionCouncilStatus } from "@omp-ui/core/types";
import { t } from "../../lib/i18n";
import { backendState, rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const MEMBER: CouncilMember = { name: "alpha", model: "probe/member", instructions: null, enabled: true };
const getSessionCouncilStatus = vi.fn(
  async (): Promise<SessionCouncilStatus> => ({ status: "empty", configWarnings: [] }),
);
Object.assign(h.mockBackend, { getSessionCouncilStatus });

function allPrompts(): string[] {
  return h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message));
}

function commandRows(): Array<{
  name: string;
  args: string;
  status: string;
  error?: string;
  action?: string;
}> {
  return (h.useStore.getState().rpc[h.TAB]?.items ?? []).flatMap((item) =>
    item.kind === "command"
      ? [{ name: item.name, args: item.args, status: item.status, error: item.error, action: item.action }]
      : [],
  );
}

/** Answers ordinary dispatches so bypass and acknowledgement paths can settle. */
async function runLine(line: string): Promise<void> {
  const answered = new Set<unknown>();
  const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
  let settled = false;
  void promise.finally(() => (settled = true));
  for (let wave = 0; wave < 8 && !settled; wave++) {
    await h.flushMicrotasks();
    for (const { tabId, cmd } of [...h.sent]) {
      if (answered.has(cmd)) continue;
      answered.add(cmd);
      h.respond(tabId, cmd, { agentInvoked: false });
    }
  }
  await promise;
}

function seed(councilEnabled: boolean, members: readonly CouncilMember[] = []): void {
  h.backendState = { ...h.stateWithRecord("sess-1"), councilEnabled };
  h.backendState.projects[0]!.project.councilRoster = { instructions: null, members };
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p" })],
    rpc: {
      [h.TAB]: rpcTabState({
        commands: [{ name: "council", description: "", source: "extension" }],
      }),
    },
  });
}

function expectRefusal(error: string, action?: string): void {
  expect(h.sent).toEqual([]);
  expect(commandRows()).toEqual([
    { name: "council", args: "x", status: "failed", error, action },
  ]);
}

describe("/council in a native tab (ADR-0088)", () => {
  beforeEach(() => {
    getSessionCouncilStatus.mockImplementation(async () => ({ status: "empty", configWarnings: [] }));
    seed(true);
  });

  it.each([true, false])("uses an available process despite current empty Settings (enabled=%s), retaining acknowledgements", async (enabled) => {
    seed(enabled);
    const status = h.deferred<SessionCouncilStatus>();
    getSessionCouncilStatus.mockReturnValueOnce(status.promise);
    const line = "/council review  src/\n keep spacing  ";
    const run = h.useStore.getState().runSlashCommand(h.TAB, line);
    expect(getSessionCouncilStatus).toHaveBeenCalledWith(h.TAB);
    expect(h.sent).toEqual([]);
    status.resolve({ status: "available", memberCount: 2 });
    await h.flushMicrotasks();
    expect(allPrompts()).toEqual([line]);
    expect(commandRows()).toEqual([
      expect.objectContaining({ name: "council", args: "review  src/\n keep spacing", status: "running", action: undefined }),
    ]);
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: !enabled });
    await run;
    expect(commandRows()[0]?.status).toBe(enabled ? "done" : "agent");
  });

  it("refuses an empty launch even after current Settings gain members", async () => {
    seed(true, [MEMBER]);
    await runLine("/council x");
    expect(getSessionCouncilStatus).toHaveBeenCalledWith(h.TAB);
    expectRefusal(t("council.command.empty"), "council-settings");
  });

  it("keeps empty-launch warnings with the relaunch guidance and settings action", async () => {
    seed(false, [MEMBER]);
    getSessionCouncilStatus.mockResolvedValue({ status: "empty", configWarnings: ["Member alpha has no model"] });
    await runLine("/council x");
    expectRefusal(`${t("council.command.empty")}\nMember alpha has no model`, "council-settings");
  });

  it.each<CouncilInitializationStage>(["resolve", "overlay", "snapshot", "extension"])("reports %s initialization failure instead of suggesting Settings or sending a prompt", async (stage) => {
    seed(true, [MEMBER]);
    getSessionCouncilStatus.mockResolvedValue({ status: "unavailable", failure: { stage, message: "permission denied" } });
    await runLine("/council x");
    expectRefusal(t("council.command.unavailable", {
      stage: t(`council.command.stage.${stage}`),
      cause: "permission denied",
    }));
  });

  it("refuses while starting, then uses readiness without a Settings veto", async () => {
    seed(false);
    getSessionCouncilStatus
      .mockResolvedValueOnce({ status: "starting" })
      .mockResolvedValueOnce({ status: "available", memberCount: 1 });
    await runLine("/council x");
    expectRefusal(t("council.command.starting"));
    await runLine("/council x");
    expect(allPrompts()).toEqual(["/council x"]);
    expect(commandRows().map(({ status }) => status)).toEqual(["failed", "done"]);
  });

  it.each([
    ["disabled", "council.command.disabled"],
    ["missing-session", "council.command.missingSession"],
    ["not-live", "council.command.notLive"],
    ["terminal", "council.command.terminal"],
  ] as const)("distinguishes %s process state from current enabled Settings", async (status, key) => {
    seed(true, [MEMBER]);
    getSessionCouncilStatus.mockResolvedValue({ status });
    await runLine("/council x");
    expectRefusal(t(key));
  });

  it("reports transport errors and never falls back to the advertised bridge or model", async () => {
    seed(true, [MEMBER]);
    getSessionCouncilStatus.mockRejectedValue(new Error("Unknown channel: session:council-status"));
    await runLine("/council x");
    expectRefusal(t("council.command.queryFailed", { cause: "Unknown channel: session:council-status" }));
  });

  it.each([false, true])("refuses an available process without its advertised extension command (non-extension=%s)", async (nonExtension) => {
    getSessionCouncilStatus.mockResolvedValue({ status: "available", memberCount: 1 });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: nonExtension ? [{ name: "council", description: "", source: "builtin" }] : [],
        }),
      },
    });
    await runLine("/council x");
    expectRefusal(t("council.command.missingBridge"));
  });

  it("keeps a bare bridge ack running until its correlated prompt_result arrives", async () => {
    seed(false);
    getSessionCouncilStatus.mockResolvedValue({ status: "available", memberCount: 1 });
    const run = h.useStore.getState().runSlashCommand(h.TAB, "/council x");
    await h.flushMicrotasks();
    const cmd = h.sent[0]!.cmd;
    h.respond(h.TAB, cmd, {});
    await run;
    expect(commandRows()[0]?.status).toBe("running");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "prompt_result", id: "unrelated", agentInvoked: false });
    expect(commandRows()[0]?.status).toBe("running");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "prompt_result", id: cmd.id, agentInvoked: false });
    expect(commandRows()[0]?.status).toBe("done");
  });

  it.each(["pty", "chat"] as const)("preserves the ordinary %s path without querying Council", async (kind) => {
    getSessionCouncilStatus.mockResolvedValue({ status: "unavailable", failure: { stage: "resolve", message: "must not be consulted" } });
    const record = h.backendState.projects[0]!.sessions[0]!;
    h.useStore.setState({
      ...(kind === "chat" ? { state: backendState({ chats: [{ ...record, chat: true }] }) } : {}),
      tabs: [tabInfo({ tabId: h.TAB, mode: kind === "pty" ? "pty" : "rpc-ui", projectCwd: "/p" })],
      rpc: { [h.TAB]: rpcTabState({ commands: [] }) },
    });
    await runLine("/council x");
    expect(getSessionCouncilStatus).not.toHaveBeenCalled();
    expect(allPrompts()).toEqual(["/council x"]);
    expect(commandRows()).toEqual([]);
  });
});
