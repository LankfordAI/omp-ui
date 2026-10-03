// Session parameter slice tests (moved verbatim from store.test.ts for #295).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EXPERIMENT_PROPOSAL_SENTINEL, type ExperimentProposal } from "@omp-ui/core/autoresearch";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import type { RenderItem } from "../../lib/transcript";
import { h } from "../../test/store-harness";

const ONE_IMAGE_CONTEXT =
  "[omp-ui attachment routing: For tool calls, this prompt's attached image is available as attachment://1. Attachment handles restart at 1 for each prompt.]";
const TWO_IMAGE_CONTEXT =
  "[omp-ui attachment routing: For tool calls, this prompt's attached images are available as attachment://1, attachment://2. Attachment handles restart at 1 for each prompt.]";
describe("prompting, slash commands, and session ops", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
    h.sent.length = 0;
  });

  /** Answers every outstanding command with `data`, so a method promise settles. */
  const settleAll = async (data: unknown = {}): Promise<void> => {
    for (let wave = 0; wave < 3; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, data);
    }
  };

  it("sendPrompt always sends the prompt frame, with steer as the streaming behaviour", async () => {
    const ready = h.useStore.getState().sendPrompt(h.TAB, "do the thing");
    // Phase 1 of auto-titling also sends on the first prompt, so select the
    // prompt frame by type rather than by position.
    const frame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(frame).toBeDefined();
    expect(frame!.cmd).toMatchObject({
      type: "prompt",
      message: "do the thing",
      streamingBehavior: "steer",
    });
    await settleAll();
    await expect(ready).resolves.toBe(true);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    const steering = h.useStore.getState().sendPrompt(h.TAB, "actually, wait");
    const steerFrame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(steerFrame!.cmd).toMatchObject({
      type: "prompt",
      message: "actually, wait",
      streamingBehavior: "steer",
    });
    await settleAll();
    await expect(steering).resolves.toBe(true);
  });

  it("sendPrompt returns false when no command is accepted (issue #283)", async () => {
    h.useStore.setState({ rpc: {} });
    await expect(h.useStore.getState().sendPrompt(h.TAB, "missing")).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "starting" }) } });
    await expect(h.useStore.getState().sendPrompt(h.TAB, "starting")).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);
    await expect(h.useStore.getState().compactSession(h.TAB)).resolves.toBe("failed");
    // A command never sent must not mark the transcript.
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(0);
    await h.useStore.getState().exportHtml(h.TAB);
    expect(h.sent).toHaveLength(0);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "ready" }) } });
    const failed = h.useStore.getState().sendPrompt(h.TAB, "rejected");
    const promptFrame = h.sent.find((s) => s.cmd.type === "prompt");
    h.respond(h.TAB, promptFrame!.cmd, "prompt rejected", false);
    await expect(failed).resolves.toBe(false);
  });

  it("sendPrompt honours an explicit follow_up route while running", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    const promise = h.useStore
      .getState()
      .sendPrompt(h.TAB, "and then this", "follow_up");
    const followFrame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(followFrame!.cmd).toMatchObject({
      type: "prompt",
      message: "and then this",
      streamingBehavior: "followUp",
    });
    await settleAll();
    await promise;
  });

  it("sendPrompt feeds the auto-titler immediately, no agent_end needed", async () => {
    const promise = h.useStore
      .getState()
      .sendPrompt(h.TAB, "Refactor the auth module");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe(
      "Refactor the auth module",
    );
    // Flush once so the async rename's set_session_name lands, then capture it
    // before settleAll consumes the sent queue.
    await h.flushMicrotasks();
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Refactor the auth module");
    // settleAll answers the prompt (and the rename) so sendPrompt resolves.
    await settleAll();
    await promise;
  });

  it("routes prompt and abort image handles without changing image objects", async () => {
    const images = [
      { type: "image" as const, data: "first", mimeType: "image/png" },
      { type: "image" as const, data: "second", mimeType: "image/webp" },
    ];
    const prompt = h.useStore.getState().sendPrompt(h.TAB, "compare", "steer", images);
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe("compare");
    const promptFrame = h.sent.find((sent) => sent.cmd.type === "prompt");
    expect(promptFrame?.cmd).toMatchObject({
      type: "prompt",
      message: `compare\n\n${TWO_IMAGE_CONTEXT}`,
      streamingBehavior: "steer",
      images,
    });
    await settleAll();
    await prompt;

    h.sent.length = 0;
    const abort = h.useStore.getState().abortAndPrompt(h.TAB, "inspect", [images[0]!]);
    expect(h.sent[0]?.cmd).toMatchObject({
      type: "abort_and_prompt",
      message: `inspect\n\n${ONE_IMAGE_CONTEXT}`,
      images: [images[0]],
    });
    await settleAll();
    await abort;
  });

  it("runSlashCommand normalizes the leading slash and never titles", async () => {
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "advisor on");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/advisor on",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /new opens a new session tab instead of prompting omp", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = null;
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().runSlashCommand(h.TAB, "/new");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
    });
    expect(h.sent).toEqual([]); // nothing reached omp
    expect(h.useStore.getState().activeTabId).toBe("fresh-tab");
  });

  it("runSlashCommand forwards /new with arguments to omp", async () => {
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/new later");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/new later",
    });
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /new falls back to omp when the tab is unknown", async () => {
    h.useStore.setState({ tabs: [] });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/new");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/new" });
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan toggles plan mode on instead of prompting omp", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    // The configured plan format rides the `on` command (issue #109).
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan on matches the bare toggle", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan on");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan carries the markdown format when that is the setting", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
      state: { ...h.stateWithRecord("s1"), planFormat: "md" },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on md",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan off exits plan mode", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan off");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /no-plan exits plan mode", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/no-plan");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan with arguments to omp", async () => {
    const promise = h.useStore
      .getState()
      .runSlashCommand(h.TAB, "/plan rewrite auth");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/plan rewrite auth",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan from a pty tab to its TUI", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "pty", projectCwd: "/p", hidden: false }),
      ],
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/plan" });
    await settleAll();
    await promise;
  });

  /** Advertises commands so the echo path treats them as known (issue #241). */
  const seedCommands = (
    ...commands: Array<{ name: string; aliases?: string[] }>
  ): void => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: commands.map((c) => ({ ...c, description: "" })),
        }),
      },
    });
  };

  it("runSlashCommand echoes an advertised command and settles done when no agent ran", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "usage",
      args: "",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("runSlashCommand matches aliases and marks the row agent when a turn starts", async () => {
    seedCommands({ name: "usage", aliases: ["cost"] });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/cost this month");
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "cost",
      args: "this month",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: true });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "agent",
    });
  });

  it("refreshes usage after an advertised soft compact command", async () => {
    seedCommands({ name: "compact", aliases: ["shrink"] });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: [
            { name: "compact", aliases: ["shrink"], description: "" },
          ],
          session: {
            ...emptySessionRuntime(),
            contextUsage: {
              tokens: 210049,
              contextWindow: 256000,
              percent: 82.1,
            },
          },
        }),
      },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/shrink soft");
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await h.flushMicrotasks();
    const state = h.sent.find((s) => s.cmd.type === "get_state");
    const stats = h.sent.find((s) => s.cmd.type === "get_session_stats");
    expect(state).toBeDefined();
    expect(stats).toBeDefined();
    h.respond(h.TAB, state!.cmd, {
      contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
    });
    h.respond(h.TAB, stats!.cmd, {
      userMessages: 2,
      assistantMessages: 3,
      tokens: { input: 10, output: 20, total: 30 },
      cost: 0.5,
    });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(
      47247,
    );
  });

  it("does not refresh usage after a failed compact command", async () => {
    seedCommands({ name: "compact" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/compact soft");
    h.respond(h.TAB, h.sent[0]!.cmd, "compaction failed", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "failed",
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(false);
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(false);
  });

  it("keeps a completed compact command when half the usage refresh fails", async () => {
    seedCommands({ name: "compact" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/compact soft");
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await h.flushMicrotasks();
    const state = h.sent.find((s) => s.cmd.type === "get_state");
    const stats = h.sent.find((s) => s.cmd.type === "get_session_stats");
    h.respond(h.TAB, state!.cmd, {
      contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
    });
    h.respond(h.TAB, stats!.cmd, "stats unavailable", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(
      47247,
    );
  });

  it("runSlashCommand settles failed with omp's own error text", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    h.respond(h.TAB, h.sent[0]!.cmd, "prompt rejected while streaming", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "failed",
      error: 'RPC command "prompt" failed: prompt rejected while streaming',
    });
  });

  it("a bare ack without agentInvoked stays running until prompt_result settles it", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    const cmd = h.sent[0]!.cmd;
    h.respond(h.TAB, cmd, {});
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "running",
    });
    // A foreign prompt_result must not settle it.
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "prompt_result", id: "other" });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      status: "running",
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "prompt_result",
      id: cmd.id,
      agentInvoked: false,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("a bare ack settles to agent on the tab's next agent_start", async () => {
    seedCommands({ name: "commit" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/commit");
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    const row = h.useStore
      .getState()
      .rpc[h.TAB]!.items.find((i) => i.kind === "command");
    expect(row).toMatchObject({ kind: "command", status: "agent" });
  });

  it("an unadvertised /word forwards as a literal prompt with no command row", async () => {
    const promise = h.useStore
      .getState()
      .runSlashCommand(h.TAB, "/nonexistent-xyz do it");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/nonexistent-xyz do it",
    });
    expect(
      h.useStore.getState().rpc[h.TAB]!.items.some((i) => i.kind === "command"),
    ).toBe(false);
    await settleAll();
    await promise;
  });

  it("bare /mcp and /mcp list open the capabilities viewer instead of prompting omp", async () => {
    h.useStore.setState({
      // A record without a worktree: sessionCwd is its project root.
      state: h.stateWithRecord("sess-1", "live", null),
      capabilitiesViewer: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/p",
      tabId: h.TAB,
      section: "mcp",
      instanceId: null,
    });
    h.useStore.getState().closeCapabilitiesViewer();
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp list");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/p",
      tabId: h.TAB,
      section: "mcp",
      instanceId: null,
    });
    h.useStore.getState().closeCapabilitiesViewer();
  });

  it("bare /mcp in a worktree session opens the viewer at the checkout (issue #325)", async () => {
    h.backendState = h.stateWithRecord("sess-1", "live", {
      path: "/wt",
      branch: "omp-ui/abc",
      base: "main",
    });
    h.useStore.setState({
      state: h.backendState,
      capabilitiesViewer: null,
      // The tab still carries the project root, so only the record's
      // worktree can produce /wt here.
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/wt",
      tabId: h.TAB,
      section: "mcp",
      instanceId: null,
    });
    h.useStore.getState().closeCapabilitiesViewer();
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp list");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/wt",
      tabId: h.TAB,
      section: "mcp",
      instanceId: null,
    });
    h.useStore.getState().closeCapabilitiesViewer();
  });

  it("bare /mcp falls back to the tab's project root when no record is loaded", async () => {
    h.useStore.setState({
      state: null,
      capabilitiesViewer: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/p",
      tabId: h.TAB,
      section: "mcp",
      instanceId: null,
    });
    h.useStore.getState().closeCapabilitiesViewer();
  });

  it("other /mcp subcommands forward with the command lifecycle", async () => {
    h.useStore.setState({
      capabilitiesViewer: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    seedCommands({ name: "mcp" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/mcp reauth linear");
    expect(h.useStore.getState().capabilitiesViewer).toBeNull();
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/mcp reauth linear",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "mcp",
      args: "reauth linear",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("/autoresearch lab and /autoresearch start open omp-ui's surfaces and send nothing", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      state: { ...h.backendState, experimentsEnabled: true },
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/autoresearch lab");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().lab).toMatchObject({ projectCwd: "/p", instanceId: null });
    await h.useStore.getState().runSlashCommand(h.TAB, "/autoresearch start");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().experimentDialog).toEqual({ projectCwd: "/p", instanceId: null });
  });

  it("/autoresearch start <text> interviews in this tab and opens no dialog", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      state: { ...h.backendState, experimentsEnabled: true },
    });
    h.sent.length = 0;
    const run = h.useStore.getState().runSlashCommand(h.TAB, "/autoresearch start make the tests faster");
    const prompts = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]!.cmd.message)).toContain("propose_experiment");
    expect(String(prompts[0]!.cmd.message)).toContain("make the tests faster");
    expect(h.useStore.getState().experimentDialog).toBeNull();
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, { agentInvoked: true });
    await run;
  });

  it("/autoresearch start <text> reports an unmountable bridge instead of prompting", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      state: { ...h.backendState, experimentsEnabled: true },
      rpc: {
        [h.TAB]: rpcTabState({
          autoresearch: {
            version: 1, processKey: "p", sessionId: "s", revision: 1, available: true, unavailable: null,
            mode: "off", goal: null, goalTruncated: false, lastTool: null,
            proposeUnavailable: "could not mount propose_experiment: pi.zod is missing",
          },
        }),
      },
    });
    h.sent.length = 0;
    await h.useStore.getState().runSlashCommand(h.TAB, "/autoresearch start go");
    expect(h.sent).toHaveLength(0);
    expect(h.errorMessages().at(-1)).toContain("propose_experiment");
  });

  it("every other /autoresearch line stays omp's command with the normal lifecycle", async () => {
    h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })] });
    seedCommands({ name: "autoresearch" });
    for (const line of ["/autoresearch", "/autoresearch off", "/autoresearch clear", "/autoresearch lab now"]) {
      h.sent.length = 0;
      const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
      expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: line });
      expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
        kind: "command",
        name: "autoresearch",
        status: "running",
      });
      h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
      await promise;
    }
    expect(h.useStore.getState().lab).toBeNull();
    expect(h.useStore.getState().experimentDialog).toBeNull();
  });

  it("/autoresearch lab from a pty tab reaches its TUI untouched", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, mode: "pty", projectCwd: "/p" })],
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/autoresearch lab");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/autoresearch lab" });
    expect(h.useStore.getState().lab).toBeNull();
    await settleAll();
    await promise;
  });

  it("/autoresearch lab and start reach omp verbatim while the flag is off", async () => {
    h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })] });
    for (const line of ["/autoresearch lab", "/autoresearch start go"]) {
      h.sent.length = 0;
      const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
      expect(h.sent.some((s) => s.cmd.type === "prompt" && s.cmd.message === line)).toBe(true);
      await settleAll();
      await promise;
    }
    expect(h.useStore.getState().lab).toBeNull();
    expect(h.useStore.getState().experimentDialog).toBeNull();
  });

  it("busy is true while a command is in flight and survives a concurrent one", async () => {
    const first = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" });
    const second = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_session_stats" });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);

    const [a, b] = h.sent.splice(0);
    h.respond(h.TAB, a!.cmd, {});
    await first;
    // One settled, one still outstanding — busy must not drop yet.
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
    h.respond(h.TAB, b!.cmd, {});
    await second;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("keeps busy ref-counted when one loud command times out beside another", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const timeout = h.useStore.getState().runSlashCommand(h.TAB, "/compact");
      await vi.advanceTimersByTimeAsync(5_000);
      const success = h.useStore.getState().setThinkingLevel(h.TAB, "high");
      const surviving = h.sent.at(-1)!.cmd;

      await vi.advanceTimersByTimeAsync(25_000);
      await timeout;
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toMatchObject({
        message: expect.stringContaining('RPC command "prompt"'),
        kind: "command",
        fatal: false,
        command: "prompt",
        timeoutMs: 30_000,
        sessionStatus: "ready",
        liveState: "live",
        recovery: expect.stringMatching(
          /may still complete.*resending can duplicate work/,
        ),
      });
      expect(h.rpcCommandMachinery.snapshotPending(h.TAB).size).toBe(1);
      expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
      expect(warn).toHaveBeenCalledOnce();

      h.respond(h.TAB, surviving, {});
      await success;
      expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("quiet commands never raise busy, so background sync can't strobe the sweeps", async () => {
    const promise = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_subagents" }, { quiet: true });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
    h.respond(h.TAB, h.sent.pop()!.cmd, { subagents: [] });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("a quiet timeout posts one dim notice and never paints the session failure (issue #302)", async () => {
    const T = "wedge-tab-1";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await promise;
      const tab = h.useStore.getState().rpc[T]!;
      expect(tab.failure).toBeUndefined();
      expect(tab.busy).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[rpc] command timeout",
        expect.objectContaining({
          command: "get_subagents",
          pendingCommandCount: 0,
          pending: [],
        }),
      );
      const notices = tab.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!).toMatchObject({
        kind: "notice",
        level: "info",
        text: 'background "get_subagents" timed out after 30.0s — no other command in flight',
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces repeated quiet timeouts in one wedge episode to a single notice (issue #302)", async () => {
    const T = "wedge-tab-2";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = h.useStore.getState().refreshState(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      const second = h.useStore.getState().refreshStats(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await second;
      const tab = h.useStore.getState().rpc[T]!;
      expect(tab.failure).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      const notices = tab.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain('background "get_state" timed out after 30.0s');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a quiet timeout names the command still holding the chain, beside its loud banner (issue #302)", async () => {
    const T = "wedge-tab-3";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): compact t=0, heartbeat t=5, compact budget t=30,
      // heartbeat budget t=35.
      const wedge = h.useStore.getState().compactSession(T);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(25_000);
      await wedge;
      const banner = h.useStore.getState().rpc[T]!.failure;
      expect(banner).toMatchObject({ command: "compact", kind: "command", fatal: false });
      await vi.advanceTimersByTimeAsync(5_000);
      await quiet;
      expect(h.useStore.getState().rpc[T]!.failure).toBe(banner);
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind compact (timed out 5.0s ago, response not yet observed)',
      );
      expect(warn).toHaveBeenNthCalledWith(
        1,
        "[rpc] command timeout",
        expect.objectContaining({
          command: "compact",
          pendingCommandCount: 1,
          pending: [{ command: "get_subagents", quiet: true, elapsedMs: 25_000 }],
        }),
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        "[rpc] command timeout",
        expect.objectContaining({ command: "get_subagents", pending: [] }),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("the loud banner names the command holding omp's chain (issue #337)", async () => {
    const T = "wedge-tab-loud";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // compact t=0 (holds the chain), a second loud command t=5, compact
      // budget t=30, second budget t=35.
      const held = h.useStore.getState().compactSession(T);
      await vi.advanceTimersByTimeAsync(5_000);
      const queued = h.useStore.getState().setSteeringMode(T, "manual");
      await vi.advanceTimersByTimeAsync(25_000);
      await held;
      await vi.advanceTimersByTimeAsync(5_000);
      await queued;

      expect(h.useStore.getState().rpc[T]!.failure!.message).toBe(
        'RPC command "set_steering_mode" timed out after its 30.0s response budget' +
          " — queued behind compact (timed out 5.0s ago, response not yet observed)",
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("re-arms the quiet-failure notice on a quiet success; loud failures survive quiet timeouts (issue #302)", async () => {
    const T = "wedge-tab-4";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      const ok = h.useStore.getState().refreshState(T);
      h.respond(T, h.sent.pop()!.cmd, {});
      await ok;
      const second = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await second;
      expect(
        h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice"),
      ).toHaveLength(2);
      const failed = h.useStore.getState().setThinkingLevel(T, "high");
      h.respond(T, h.sent.pop()!.cmd, "unknown level", false);
      await failed;
      const transient = h.useStore.getState().rpc[T]!.failure;
      expect(transient).toBeDefined();
      const third = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await third;
      expect(h.useStore.getState().rpc[T]!.failure).toBe(transient);
      expect(
        h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice"),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a late response retires the timed-out holder before the quiet timeout attributes it (issue #302)", async () => {
    const T = "wedge-tab-5";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, heartbeat t=5, set_model budget t=30,
      // late response t=32, heartbeat budget t=35.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(27_000);
      await typed;
      // The holder's late response arrives before the victim's budget: the
      // chain provably moved past it, so attribution must not fire (issue #302).
      h.useStore.getState().handleRpcFrame(T, {
        type: "response",
        id: h.sent[0]!.cmd.id,
        command: "set_model",
        success: true,
        data: {},
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — no other command in flight',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a bash success does not retire the attribution: it bypasses the serial chain (issue #302)", async () => {
    const T = "wedge-tab-6";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, its budget t=30, bash t=32
      // (completes at t=32), heartbeat t=32, heartbeat budget t=62.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(32_000);
      await typed;
      const bash = h.useStore.getState().rpcCommand(T, { type: "bash", command: "true" });
      const bCmd = h.sent.at(-1)!.cmd;
      h.respond(T, bCmd, {});
      await bash; // completes — but it never queued, so it proves nothing (issue #302)
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(33_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind set_model (timed out 32.0s ago, response not yet observed)',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a non-bash success retires earlier timeouts: the chain provably drained (issue #302)", async () => {
    const T = "wedge-tab-7";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, its budget t=30, set_steering_mode t=32
      // (completes at t=32), heartbeat t=32, heartbeat budget t=62.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(32_000);
      await typed;
      const loud = h.useStore
        .getState()
        .rpcCommand(T, { type: "set_steering_mode", mode: "manual" });
      const lCmd = h.sent.at(-1)!.cmd;
      h.respond(T, lCmd, {});
      await loud; // its completion proves the chain drained past the wedge (issue #302)
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(33_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — no other command in flight',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("attributes the earliest unretired timeout, the command executing while the rest queue (issue #302)", async () => {
    const T = "wedge-tab-8";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, set_steering_mode t=10, heartbeat t=15;
      // budgets fire at t=30, t=40, t=45.
      const first = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typedFirst = expect(first).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);
      const second = h.useStore
        .getState()
        .rpcCommand(T, { type: "set_steering_mode", mode: "manual" });
      const typedSecond = expect(second).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await typedFirst;
      await typedSecond;
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind set_model (timed out 15.0s ago, response not yet observed)',
      );
      expect(notices[0]!.text).not.toContain("set_steering_mode");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a loud command's busy survives an interleaved quiet one settling", async () => {
    const loud = h.useStore.getState().rpcCommand(h.TAB, { type: "compact" });
    const quiet = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_state" }, { quiet: true });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);

    const [a, b] = h.sent.splice(0);
    // The quiet one settles first — busy must hold for the loud one.
    h.respond(h.TAB, b!.cmd, {});
    await quiet;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
    h.respond(h.TAB, a!.cmd, {});
    await loud;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("a failed command records a nonfatal command failure", async () => {
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    const cmd = h.sent.pop()!.cmd;
    h.respond(h.TAB, cmd, "unknown level", false);
    await expect(promise).resolves.toBeUndefined();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.failure).toMatchObject({
      message: 'RPC command "set_thinking_level" failed: unknown level',
      kind: "command",
      fatal: false,
      command: "set_thinking_level",
      liveState: "live",
      sessionStatus: "ready",
      recovery: expect.stringMatching(/Refresh state/),
    });
    // A rejected setting must not wedge a live tab into the error state.
    expect(tab.status).toBe("ready");
    expect(tab.session.thinkingLevel).toBeNull();
  });

  it("a quiet success preserves a nonfatal failure until a loud command succeeds", async () => {
    const failed = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    h.respond(h.TAB, h.sent.pop()!.cmd, "unknown level", false);
    await failed;
    const transient = h.useStore.getState().rpc[h.TAB]!.failure;

    const refresh = h.useStore.getState().refreshState(h.TAB);
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await refresh;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBe(transient);

    const recovered = h.useStore.getState().setThinkingLevel(h.TAB, "low");
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await recovered;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
  });

  describe("promoteQueuedMessage (issue #714)", () => {
    const wire = `look at this\n\n${ONE_IMAGE_CONTEXT}`;

    it("sends exactly the raw queue-chip text and nothing else when promoted", async () => {
      const promise = h.useStore.getState().promoteQueuedMessage(h.TAB, wire);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.cmd).toEqual({
        type: "promote_queued_message",
        message: wire,
        id: expect.anything(),
      });
      h.respond(h.TAB, h.sent.pop()!.cmd, { promoted: true });
      await promise;
      await h.flushMicrotasks();
      expect(h.sent).toEqual([]);
    });

    it("re-reads state when the message was already delivered", async () => {
      const promise = h.useStore.getState().promoteQueuedMessage(h.TAB, wire);
      h.respond(h.TAB, h.sent.pop()!.cmd, { promoted: false });
      await promise;
      expect(h.sent.map((s) => s.cmd.type)).toEqual(["get_state"]);
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
    });

    it("a rejection records a nonfatal failure and never falls back to prompt/steer", async () => {
      const promise = h.useStore.getState().promoteQueuedMessage(h.TAB, wire);
      h.respond(h.TAB, h.sent.pop()!.cmd, "unknown command", false);
      await promise;
      await h.flushMicrotasks();
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toMatchObject({
        kind: "command",
        fatal: false,
        command: "promote_queued_message",
      });
      expect(h.sent).toEqual([]);
    });
  });

  it("setModel sends provider + modelId, not the whole model object", async () => {
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
    const promise = h.useStore.getState().setModel(h.TAB, model);
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    await settleAll(model);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.model).toMatchObject({
      id: "claude-opus-5",
    });
  });

  it("setModel remembers the model with the current thinking level", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), thinkingLevel: "high" },
        }),
      },
    });
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
    const promise = h.useStore.getState().setModel(h.TAB, model);
    await settleAll(model);
    await promise;
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "anthropic/claude-opus-5",
      "high",
    );
  });

  it("setThinkingLevel remembers the level without changing the main model", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ model: { id: "m1", name: "M1", provider: "p" } }),
      },
    });
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "max");
    await settleAll({});
    await promise;
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "p/m1",
      "max",
    );
  });

  it("setThinkingLevel auto selects the automatic mode without overwriting the resolved level", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "auto");
    expect(h.sent.at(-1)!.cmd).toMatchObject({
      type: "set_thinking_level",
      level: "auto",
    });
    await settleAll({});
    await promise;
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.thinkingConfigured).toBe("auto");
    // The pill reads the selector; the resolved value waits for the next frame.
    expect(session.thinkingLevel).toBe("low");
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "p/m1",
      "auto",
    );
  });

  it("a concrete set clears the auto selector and persists the level", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low", thinkingConfigured: "auto" },
        }),
      },
    });
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "xhigh");
    await settleAll({});
    await promise;
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.thinkingLevel).toBe("xhigh");
    expect(session.thinkingConfigured).toBeNull();
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "p/m1",
      "xhigh",
    );
  });

  it("setModel under auto persists auto, not the resolved level", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), thinkingLevel: "low", thinkingConfigured: "auto" },
        }),
      },
    });
    const model = { id: "claude-opus-5", name: "Opus 5", provider: "anthropic" };
    const promise = h.useStore.getState().setModel(h.TAB, model);
    await settleAll(model);
    await promise;
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "anthropic/claude-opus-5",
      "auto",
    );
  });

  it("refreshState under auto persists the selector, not get_state's resolved level", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low", thinkingConfigured: "auto" },
        }),
      },
    });
    const promise = h.useStore.getState().refreshState(h.TAB);
    await settleAll({
      model: { id: "m1", name: "M1", provider: "p" },
      thinkingLevel: "low",
    });
    await promise;
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.session.thinkingLevel).toBe("low");
    expect(tab.session.thinkingConfigured).toBe("auto");
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "p/m1",
      "auto",
    );
  });

  it("setAdvisorModel persists the advisor tuple through one backend call", async () => {
    await h.useStore.getState().setAdvisorModel(h.TAB, "openrouter/a/b:high");
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
    );
  });

  it("newSession uses the persisted mode and restores the last advisor tuple", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = false;
    project.lastAdvisorModel = "openrouter/a/b:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "new-tab" });
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("newSession mode override wins without changing the persisted default", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "openrouter/a/b:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "terminal-tab" });
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p", "pty");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
    expect(h.mockBackend.setDefaultMode).not.toHaveBeenCalled();
  });

  it("newSession falls back to terminal mode without backend state", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fallback-tab" });
    h.useStore.setState({
      state: null,
      advisorDefaults: {
        "/p": { enabled: true, model: "openrouter/a/b:high" },
      },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("newSession uses the app default advisor when the project has none (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "default-on-tab" });
    h.useStore.setState({
      state: { ...h.stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("the app default of false overrides omp config for new sessions (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "default-off-tab",
    });
    h.useStore.setState({
      state: h.stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("exportHtml pushes the returned path as a notice", async () => {
    const promise = h.useStore.getState().exportHtml(h.TAB);
    await settleAll({ path: "/tmp/session.html" });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "exported to /tmp/session.html",
        // The path rides along as data so the view can open/reveal the file
        // without parsing the text (issue #84).
        path: "/tmp/session.html",
      }),
    ]);
  });

  it("exportHtml without a path in the response leaves a plain notice", async () => {
    const promise = h.useStore.getState().exportHtml(h.TAB);
    await settleAll({});
    await promise;
    const [item] = h.useStore.getState().rpc[h.TAB]!.items;
    expect(item).toMatchObject({ kind: "notice", text: "export finished" });
    expect(item).not.toHaveProperty("path");
  });

  it("compactSession marks the transcript without pasting the summary into it", async () => {
    const promise = h.useStore.getState().compactSession(h.TAB);
    await settleAll({ summary: "x".repeat(5000) });
    await promise;
    const { items } = h.useStore.getState().rpc[h.TAB]!;
    expect(items.map((i) => i.kind)).toEqual(["marker", "marker"]);
    expect(JSON.stringify(items)).not.toContain("xxxx");
  });

  it("compactSession reports omp's verdict, and a late ack settles the record (issue #336, #625)", async () => {
    const acked = h.useStore.getState().compactSession(h.TAB);
    await settleAll({ summary: "…" });
    await expect(acked).resolves.toBe("acked");
    // In-time path: exactly one completion marker, byte-identical to the old
    // transcript, and the record is already closed.
    const early = h.useStore.getState().rpc[h.TAB]!;
    expect(early.compacting).toBeUndefined();
    const closed = early.items.filter(
      (i): i is Extract<RenderItem, { kind: "marker" }> =>
        i.kind === "marker" && i.label.startsWith("context compacted"),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ label: "context compacted" });

    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.sent.length = 0;
      const held = h.useStore.getState().compactSession(h.TAB);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(held).resolves.toBe("pending");
      expect(h.useStore.getState().rpc[h.TAB]!.compacting).toBeDefined();
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toMatchObject({
        kind: "command",
        command: "compact",
      });
      // The stage-one marker stays in the transcript: count only what this
      // compaction closes.
      const beforeClose = h.useStore.getState().rpc[h.TAB]!.items.length;
      // The late response frame is the completion event: the banner retires,
      // the start marker closes with the duration, and usage refreshes.
      const compact = h.sent.find((s) => s.cmd.type === "compact")!;
      h.respond(h.TAB, compact.cmd, { summary: "…" });
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.compacting).toBeUndefined();
      expect(tab.failure).toBeUndefined();
      const closes = tab.items.slice(beforeClose).filter(
        (i): i is Extract<RenderItem, { kind: "marker" }> =>
          i.kind === "marker" && i.label.startsWith("context compacted"),
      );
      expect(closes).toHaveLength(1);
      expect(closes[0]).toMatchObject({ label: "context compacted — 31.0s" });
      expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a late error response closes the compaction failed, banner intact and no completion marker (issue #625)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const held = h.useStore.getState().compactSession(h.TAB);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(held).resolves.toBe("pending");
      const compact = h.sent.find((s) => s.cmd.type === "compact")!;
      h.respond(h.TAB, compact.cmd, "compaction refused", false);
      await h.flushMicrotasks();
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.compacting).toBeUndefined();
      expect(tab.failure).toMatchObject({ kind: "command", command: "compact" });
      const markers = tab.items.filter((i) => i.kind === "marker");
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({ label: "compacting context" });
      // A compaction that never happened claims no fresh usage.
      expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a second compactSession during one in flight reports without sending or marking (issue #625)", async () => {
    const first = h.useStore.getState().compactSession(h.TAB);
    await h.flushMicrotasks();
    // omp refuses a second compaction outright; the guard behind the disabled
    // button reports the in-flight one instead of re-sending.
    await expect(h.useStore.getState().compactSession(h.TAB)).resolves.toBe("failed");
    expect(h.sent.filter((s) => s.cmd.type === "compact")).toHaveLength(1);
    const markers = h.useStore.getState().rpc[h.TAB]!.items.filter((i) => i.kind === "marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ label: "compacting context" });
    await settleAll({ summary: "…" });
    await first;
  });

  describe("automatic compaction usage convergence", () => {
    const seedUsage = (tokens = 210049): void => {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            session: {
              ...emptySessionRuntime(),
              contextUsage: {
                tokens,
                contextWindow: 256000,
                percent: (tokens / 256000) * 100,
              },
            },
          }),
        },
      });
    };
    const stateRequests = (): Array<{ tabId: string; cmd: Record<string, unknown> }> =>
      h.sent.filter((request) => request.cmd.type === "get_state");
    const emitSuccessfulEnd = (tokensBefore = 210049): void =>
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_compaction_end",
        result: { tokensBefore },
      });

    it("waits through a stale first snapshot and applies the reduced state", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        expect(stateRequests()).toHaveLength(1);
        expect(h.sent.filter((request) => request.cmd.type === "get_session_stats")).toHaveLength(1);
        h.respond(h.TAB, stateRequests()[0]!.cmd, {
          contextUsage: { tokens: 210049, contextWindow: 256000, percent: 82.1 },
        });
        await h.flushMicrotasks();
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(210049);
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS);
        expect(stateRequests()).toHaveLength(2);
        h.respond(h.TAB, stateRequests()[1]!.cmd, {
          contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
        });
        await h.flushMicrotasks();
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(47247);
        expect(h.useStore.getState().rpc[h.TAB]!.items).toContainEqual(
          expect.objectContaining({
            kind: "marker",
            label: "auto-compaction finished",
            tone: "copper",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies a reduced first snapshot without scheduling a retry", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        h.respond(h.TAB, stateRequests()[0]!.cmd, {
          contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
        });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 2);
        expect(stateRequests()).toHaveLength(1);
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(47247);
      } finally {
        vi.useRealTimers();
      }
    });

    it("bounds stale and failed snapshots to the configured attempt count", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        for (let attempt = 0; attempt < h.COMPACTION_USAGE_MAX_ATTEMPTS; attempt++) {
          const request = stateRequests()[attempt]!;
          h.respond(
            h.TAB,
            request.cmd,
            attempt % 2 === 0
              ? { contextUsage: { tokens: 210049, contextWindow: 256000, percent: 82.1 } }
              : "not ready",
            attempt % 2 === 0,
          );
          await h.flushMicrotasks();
          await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS);
        }
        expect(stateRequests()).toHaveLength(h.COMPACTION_USAGE_MAX_ATTEMPTS);
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 10);
        expect(stateRequests()).toHaveLength(h.COMPACTION_USAGE_MAX_ATTEMPTS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not apply a response from a superseded compaction", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        emitSuccessfulEnd(180000);
        await h.flushMicrotasks();
        const [older, newer] = stateRequests();
        h.respond(h.TAB, newer!.cmd, {
          contextUsage: { tokens: 50000, contextWindow: 256000, percent: 19.5 },
        });
        await h.flushMicrotasks();
        h.respond(h.TAB, older!.cmd, {
          contextUsage: { tokens: 40000, contextWindow: 256000, percent: 15.6 },
        });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 2);
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(50000);
        expect(stateRequests()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps one-shot behavior for aborted or malformed ends", async () => {
      vi.useFakeTimers();
      try {
        for (const frame of [
          { type: "auto_compaction_end", aborted: true, result: { tokensBefore: 210049 } },
          { type: "auto_compaction_end" },
        ]) {
          h.sent.length = 0;
          seedUsage();
          h.useStore.getState().handleRpcFrame(h.TAB, frame);
          await h.flushMicrotasks();
          expect(stateRequests()).toHaveLength(1);
          expect(h.sent.filter((request) => request.cmd.type === "get_session_stats")).toHaveLength(1);
          h.respond(h.TAB, stateRequests()[0]!.cmd, {});
          await h.flushMicrotasks();
          await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 10);
          expect(stateRequests()).toHaveLength(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("branchSession forks the transcript into a new tab and leaves the source untouched (issue #83)", async () => {
    const forked = {
      ...h.stateWithRecord("sess-fork").projects[0]!.sessions[0]!,
      tabId: "tab-fork",
    };
    h.backendState.projects[0]!.sessions.push(forked);
    h.mockBackend.forkSession.mockResolvedValueOnce({ tabId: "tab-fork" });
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
    });

    await h.useStore.getState().branchSession(h.TAB);

    expect(h.mockBackend.forkSession).toHaveBeenCalledWith(h.TAB);
    // The fork opens through the normal resume path and takes focus.
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: "tab-fork",
      cols: 80,
      rows: 24,
    });
    expect(h.useStore.getState().activeTabId).toBe("tab-fork");
    expect(h.useStore.getState().tabs.map((t) => t.tabId)).toEqual([
      h.TAB,
      "tab-fork",
    ]);
    // The source tab's transcript and runtime are exactly as they were.
    expect(h.useStore.getState().rpc[h.TAB]).toEqual(rpcTabState());
  });

  it("a failed branch reports the backend reason and changes nothing", async () => {
    h.mockBackend.forkSession.mockRejectedValueOnce(
      new Error("this session has no transcript to branch yet"),
    );
    h.useStore.setState({ activeTabId: h.TAB });

    await h.useStore.getState().branchSession(h.TAB);

    expect(h.errorMessages()).toEqual(["this session has no transcript to branch yet"]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
  });

  it("setTodos sends phases with tasks and re-reads the server's copy", async () => {
    const phases = [
      { phase: "Build", tasks: [{ content: "wire it", status: "pending" }] },
    ];
    const promise = h.useStore.getState().setTodos(h.TAB, phases);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "set_todos", phases });
    await settleAll({ todoPhases: phases });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.todos).toEqual(phases);
  });

  it("refreshSubagents parses the roster", async () => {
    const promise = h.useStore.getState().refreshSubagents(h.TAB);
    await settleAll({
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "running",
          description: "map the store",
        },
        { agent: "nameless" },
      ],
    });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.subagents).toEqual([
      {
        id: "s1",
        name: undefined,
        agent: "scout",
        status: "running",
        label: "map the store",
      },
    ]);
  });

  it("toggleConsole flips one tab's drawer without touching another's (issue #33)", () => {
    h.useStore.setState({ consoleOpen: {} });
    h.useStore.getState().toggleConsole(h.TAB);
    expect(h.useStore.getState().consoleOpen[h.TAB]).toBe(true);
    expect(h.useStore.getState().consoleOpen[`${h.TAB}-other`]).toBeUndefined();
    h.useStore.getState().toggleConsole(h.TAB);
    expect(h.useStore.getState().consoleOpen[h.TAB]).toBe(false);
  });

  it("openSearch/closeSearch set and clear one tab's find bar without touching another's (issue #270)", () => {
    h.useStore.setState({ searchOpen: {} });
    h.useStore.getState().openSearch(h.TAB);
    expect(h.useStore.getState().searchOpen[h.TAB]).toBe(true);
    expect(h.useStore.getState().searchOpen[`${h.TAB}-other`]).toBeUndefined();
    h.useStore.getState().closeSearch(h.TAB);
    expect(h.useStore.getState().searchOpen[h.TAB]).toBe(false);
    expect(h.useStore.getState().searchOpen[`${h.TAB}-other`]).toBeUndefined();
  });
});

describe("project default models (issue #257)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  /** Review frame whose plan file read resolves — fresh spawns seed from it. */
  const openReviewWithPlan = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
  };

  it("newSession boots the pinned advisor model ahead of last-used memory", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "pin-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "pin/advisor:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("newSession falls back to the last-used advisor model when the pin is null", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = null;
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "last-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "last/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("newSession falls back to omp's configured advisor model when no app state exists", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "cfg-tab" });
    h.useStore.setState({
      state: null,
      advisorDefaults: { "/p": { enabled: true, model: "openrouter/a/b:high" } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("keeps the pinned advisor model while the on/off chain resolves off", async () => {
    // Inert-while-off is intended: the pin is a model value, and advisor
    // on/off keeps its own chain (issue #174).
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = false;
    project.defaultAdvisorModel = "p/pin";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "dormant-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "p/pin",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("plan dispatch in a fresh session: the staged advisor tuple beats the pin", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReviewWithPlan("pd1");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-staged" });
    h.useStore.getState().executePlan(h.TAB, "fresh", {
      advisor: true,
      advisorModel: "staged/advisor",
    });
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "staged/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("plan dispatch in a fresh session: the pin wins the fallback branch", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReviewWithPlan("pd2");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-pin" });
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "pin/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("plan dispatch in a worktree session: the spec and staged advisor ride one spawn", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReviewWithPlan("pd-wt");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "wt-staged" });
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/cafebabe", baseRef: "main", baseBranch: null },
      advisor: true,
      advisorModel: "staged/advisor",
    });
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "staged/advisor",
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/cafebabe", baseRef: "main", baseBranch: null } },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("pin setters forward to the backend channel", async () => {
    await h.useStore.getState().setProjectDefaultModel("/p", "p/m");
    expect(h.mockBackend.setProjectDefaultModel).toHaveBeenCalledWith("/p", "p/m");
    await h.useStore.getState().setProjectDefaultAdvisorModel("/p", null);
    expect(h.mockBackend.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });
});


describe("re-titling (issue #433)", () => {
  const exchange = (): RenderItem[] => [
    { kind: "user", id: "u1", text: "the login button is broken on mobile" },
    {
      kind: "assistant",
      id: "a1",
      text: "the target collapses under the sheet",
      thinking: "",
      streaming: false,
    },
  ];

  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ items: exchange() }) },
    });
    h.sent.length = 0;
  });

  const ackAll = async (): Promise<void> => {
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
  };

  it("sends exactly one set_session_name and latches the rename", async () => {
    h.mockBackend.retitleSession.mockResolvedValueOnce("Fix mobile login button target");
    const run = h.useStore.getState().regenerateSessionTitle(h.TAB);
    await h.flushMicrotasks();
    expect(h.mockBackend.retitleSession).toHaveBeenCalledWith(
      "/p",
      "New session",
      "USER: the login button is broken on mobile\n\nASSISTANT: the target collapses under the sheet",
    );
    const renames = h.sent.filter((s) => s.cmd.type === "set_session_name");
    expect(renames).toHaveLength(1);
    expect(renames[0]!.cmd.name).toBe("Fix mobile login button target");
    await ackAll();
    await run;
    const rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.hasRenamed).toBe(true);
    expect(rpc.autoTitleSent).toBe("Fix mobile login button target");
    expect(rpc.titleRegeneration).toBeNull();
  });

  it("sends nothing when the model declines or answers the same title", async () => {
    for (const answer of [null, "New session"]) {
      h.mockBackend.retitleSession.mockResolvedValueOnce(answer);
      await h.useStore.getState().regenerateSessionTitle(h.TAB);
      expect(h.sent.filter((s) => s.cmd.type === "set_session_name")).toHaveLength(0);
      expect(h.useStore.getState().rpc[h.TAB]!.titleRegeneration).toBeNull();
      expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(false);
    }
  });

  it("lets a second click supersede the first", async () => {
    const first = h.deferred<string | null>();
    const second = h.deferred<string | null>();
    h.mockBackend.retitleSession
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const a = h.useStore.getState().regenerateSessionTitle(h.TAB);
    const b = h.useStore.getState().regenerateSessionTitle(h.TAB);
    expect(h.mockBackend.retitleSession).toHaveBeenCalledTimes(2);
    first.resolve("Stale answer");
    await a;
    expect(h.sent.filter((s) => s.cmd.type === "set_session_name")).toHaveLength(0);
    second.resolve("Better answer");
    await h.flushMicrotasks();
    const renames = h.sent.filter((s) => s.cmd.type === "set_session_name");
    expect(renames).toHaveLength(1);
    expect(renames[0]!.cmd.name).toBe("Better answer");
    await ackAll();
    await b;
  });

  it("notices a dormant session instead of writing through no process", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({ state: h.backendState });
    await h.useStore.getState().regenerateSessionTitle(h.TAB);
    expect(h.mockBackend.retitleSession).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.errorMessages().at(-1)).toContain("not running");
  });

  it("notices a transcript with nothing to learn yet", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ items: [exchange()[0]!] }) },
    });
    await h.useStore.getState().regenerateSessionTitle(h.TAB);
    expect(h.mockBackend.retitleSession).not.toHaveBeenCalled();
    expect(h.errorMessages().at(-1)).toContain("no exchange");
  });

  it("loses to a manual rename made mid-flight", async () => {
    const model = h.deferred<string | null>();
    h.mockBackend.retitleSession.mockReturnValueOnce(model.promise);
    const run = h.useStore.getState().regenerateSessionTitle(h.TAB);
    const renamed = structuredClone(h.backendState);
    renamed.projects[0]!.sessions[0]!.title = "Typed by hand";
    h.useStore.setState({ state: renamed });
    model.resolve("Model answer");
    await run;
    expect(h.sent.filter((s) => s.cmd.type === "set_session_name")).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.titleRegeneration).toBeNull();
  });
});

describe("reconcilePendingDialogs (issue #555)", () => {
  /** The harness record with its summary `pendingDialogs` set to `frames`. */
  const stateWithDialogs = (
    frames: Array<Record<string, unknown>> | undefined,
  ): typeof h.backendState => {
    const base = h.stateWithRecord("sess-1");
    const rec = { ...base.projects[0]!.sessions[0]! };
    if (frames === undefined) delete rec.pendingDialogs;
    else rec.pendingDialogs = frames;
    return {
      ...base,
      projects: [{ ...base.projects[0]!, sessions: [rec] }],
    };
  };

  const dialog = (id: string): Record<string, unknown> => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: "Pick an option",
  });

  const ids = (queue: unknown[]): unknown[] =>
    queue.map((q) => (typeof q === "object" && q !== null && "id" in q ? q.id : undefined));
  beforeEach(() => {
    h.sent.length = 0;
  });

  it("hydrates an empty queue from the record list, in order", () => {
    const state = stateWithDialogs([dialog("q1"), dialog("q2")]);
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(ids(h.useStore.getState().rpc[h.TAB]!.extensionQueue)).toEqual([
      "q1",
      "q2",
    ]);
  });

  it("clears a stale queue the record says is settled", () => {
    const local = dialog("q1");
    const state = stateWithDialogs([]);
    h.useStore.setState({
      state,
      rpc: { [h.TAB]: rpcTabState({ extensionQueue: [local] }) },
    });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toEqual([]);
  });

  it("drops the frame a sibling answered and keeps the rest in order", () => {
    const q1 = dialog("q1");
    const q2 = dialog("q2");
    const state = stateWithDialogs([q2]);
    h.useStore.setState({
      state,
      rpc: { [h.TAB]: rpcTabState({ extensionQueue: [q1, q2] }) },
    });
    h.useStore.getState().reconcilePendingDialogs(state);
    const queue = h.useStore.getState().rpc[h.TAB]!.extensionQueue;
    expect(ids(queue)).toEqual(["q2"]);
  });

  it("is idempotent: an identical id sequence patches nothing", () => {
    const local = dialog("q1");
    const state = stateWithDialogs([dialog("q1")]);
    h.useStore.setState({
      state,
      rpc: { [h.TAB]: rpcTabState({ extensionQueue: [local] }) },
    });
    const before = h.useStore.getState().rpc[h.TAB]!.extensionQueue;
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toBe(before);
  });

  it("leaves the queue alone when the host published no list", () => {
    const state = stateWithDialogs(undefined);
    const local = dialog("q1");
    h.useStore.setState({
      state,
      rpc: { [h.TAB]: rpcTabState({ extensionQueue: [local] }) },
    });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toEqual([local]);
  });

  const PROPOSED: ExperimentProposal = {
    goal: "faster",
    metric: "t",
    unit: "",
    direction: "lower",
    command: null,
    scopePaths: [],
    offLimits: [],
    constraints: [],
    maxIterations: null,
    brief: null,
  };
  const proposalDialog = (id: string): Record<string, unknown> => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: EXPERIMENT_PROPOSAL_SENTINEL + JSON.stringify(PROPOSED),
  });

  it("hydrates a held proposal and keeps it out of the queue, idempotently", () => {
    h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })], experimentDialog: null });
    const q = dialog("q1");
    const prop = proposalDialog("p1");
    const state = stateWithDialogs([q, prop]);
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().reconcilePendingDialogs(state);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(ids(tab.extensionQueue)).toEqual(["q1"]);
    expect(tab.experimentProposal).toMatchObject({ frame: prop, proposal: { goal: "faster" } });
    expect(h.useStore.getState().experimentDialog).toMatchObject({ proposalTabId: h.TAB });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toBe(tab.extensionQueue);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toBe(tab.experimentProposal);
    h.useStore.setState({ tabs: [], experimentDialog: null });
  });

  it("drops a proposal the summary no longer lists", () => {
    const held = { proposal: PROPOSED, frame: proposalDialog("p1") };
    const state = stateWithDialogs([]);
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState({ experimentProposal: held }) } });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toBeNull();
  });

  // Approvals (issue #681): main counts the select as a plain blocking dialog
  // while the renderer splits it into approvalPrompt — same id-based compare.
  const approvalDialog = (id: string, tool = "Bash"): Record<string, unknown> => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: `Allow tool: ${tool}\nls -la`,
    options: ["Approve", "Deny"],
  });
  const emptyPrompt = { toolName: "Bash", origin: null, reason: null, details: [], providerSafety: [] };

  it("hydrates a held approval and keeps it out of the queue, idempotently", () => {
    const q = dialog("q1");
    const appr = approvalDialog("a1");
    const state = stateWithDialogs([q, appr]);
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().reconcilePendingDialogs(state);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(ids(tab.extensionQueue)).toEqual(["q1"]);
    expect(tab.approvalPrompt).toMatchObject({ frame: appr, prompt: { toolName: "Bash" } });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toBe(tab.extensionQueue);
    expect(h.useStore.getState().rpc[h.TAB]!.approvalPrompt).toBe(tab.approvalPrompt);
  });

  it("drops an approval the summary no longer lists", () => {
    const held = { prompt: emptyPrompt, frame: approvalDialog("a1") };
    const state = stateWithDialogs([]);
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState({ approvalPrompt: held }) } });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.approvalPrompt).toBeNull();
  });

  it("reconciles the next stacked approval once a sibling answers the held one", () => {
    const state = stateWithDialogs([approvalDialog("a2", "Edit")]);
    const held = { prompt: emptyPrompt, frame: approvalDialog("a1") };
    h.useStore.setState({ state, rpc: { [h.TAB]: rpcTabState({ approvalPrompt: held }) } });
    h.useStore.getState().reconcilePendingDialogs(state);
    expect(h.useStore.getState().rpc[h.TAB]!.approvalPrompt).toMatchObject({
      frame: { id: "a2" },
      prompt: { toolName: "Edit" },
    });
  });

  it("answerApprovalPrompt sends the exact verdict and skips the send after exit", () => {
    const frame = approvalDialog("a1");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().acceptApprovalPrompt(h.TAB, emptyPrompt, frame);

    expect(h.useStore.getState().answerApprovalPrompt(h.TAB, "Deny")).toBe(true);
    expect(h.sent.at(-1)).toMatchObject({
      tabId: h.TAB,
      cmd: { type: "extension_ui_response", id: "a1", value: "Deny" },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.approvalPrompt).toBeNull();
    // Nothing held: the card's second click is a no-op.
    expect(h.useStore.getState().answerApprovalPrompt(h.TAB, "Approve")).toBe(false);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ approvalPrompt: { prompt: emptyPrompt, frame } }) }, exited: { [h.TAB]: 1 } });
    const before = h.sent.length;
    expect(h.useStore.getState().answerApprovalPrompt(h.TAB, "Approve")).toBe(true);
    expect(h.sent.length).toBe(before); // the process is gone; nothing to release
    expect(h.useStore.getState().rpc[h.TAB]!.approvalPrompt).toBeNull();
  });
});

describe("service tier selection (issue #719)", () => {
  const seedTier = (
    tier: "priority" | "ultrafast" | null,
    enabled: boolean,
    active: boolean,
  ): void => {
    const state = h.stateWithRecord("sess-1");
    state.projects[0]!.sessions[0]!.serviceTier = tier;
    h.useStore.setState({
      state,
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), fastModeEnabled: enabled, fastModeActive: active },
        }),
      },
    });
  };

  it("setFastMode off clears the persisted tier and still sends and patches the disable", async () => {
    seedTier("ultrafast", true, true);
    const promise = h.useStore.getState().setFastMode(h.TAB, false);
    expect(h.mockBackend.setSessionServiceTier).toHaveBeenCalledWith(h.TAB, null);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "set_fast_mode", enabled: false });
    h.respond(h.TAB, h.sent[0]!.cmd, { enabled: false, active: false });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.session).toMatchObject({
      fastModeEnabled: false,
      fastModeActive: false,
    });
  });

  it.each([
    { name: "from off", tier: null, enabled: false, active: false },
    { name: "when switching from active priority", tier: "priority", enabled: true, active: true },
    { name: "when retrying declined ultrafast", tier: "ultrafast", enabled: true, active: false },
  ] as const)("setServiceTier ultrafast $name writes the record, prompts directly, and quietly refreshes", async ({ tier, enabled, active }) => {
    seedTier(tier, enabled, active);
    const rpcCommand = vi.spyOn(h.useStore.getState(), "rpcCommand");
    try {
      const promise = h.useStore.getState().setServiceTier(h.TAB, "ultrafast");
      expect(h.mockBackend.setSessionServiceTier).toHaveBeenCalledWith(h.TAB, "ultrafast");
      // The record write must settle before the live tier command is sent.
      expect(h.sent).toHaveLength(0);
      await h.flushMicrotasks();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/fast ultra" });
      h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
      await h.flushMicrotasks();
      expect(h.sent.map(({ cmd }) => cmd.type)).toEqual(["prompt", "get_state"]);
      expect(rpcCommand).toHaveBeenCalledWith(h.TAB, { type: "get_state" }, { quiet: true });
      h.respond(h.TAB, h.sent[1]!.cmd, { fastModeEnabled: true, fastModeActive: true });
      await promise;
      expect(h.useStore.getState().rpc[h.TAB]!.session).toMatchObject({
        fastModeEnabled: true,
        fastModeActive: true,
      });
    } finally {
      rpcCommand.mockRestore();
    }
  });

  it.each([
    { name: "from off", tier: null, enabled: false },
    { name: "when recovering from declined ultrafast", tier: "ultrafast", enabled: true },
  ] as const)("setServiceTier priority $name writes the record and enables and patches fast mode", async ({ tier, enabled }) => {
    seedTier(tier, enabled, false);
    const promise = h.useStore.getState().setServiceTier(h.TAB, "priority");
    expect(h.mockBackend.setSessionServiceTier).toHaveBeenCalledWith(h.TAB, "priority");
    expect(h.sent).toHaveLength(0);
    await h.flushMicrotasks();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "set_fast_mode", enabled: true });
    h.respond(h.TAB, h.sent[0]!.cmd, { enabled: true, active: true });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.session).toMatchObject({
      fastModeEnabled: true,
      fastModeActive: true,
    });
  });

  it("setServiceTier priority while already active writes only the record", async () => {
    seedTier("priority", true, true);
    await h.useStore.getState().setServiceTier(h.TAB, "priority");
    expect(h.mockBackend.setSessionServiceTier).toHaveBeenCalledWith(h.TAB, "priority");
    expect(h.sent).toEqual([]);
  });
});

describe("fast mode (issue #677)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("setFastMode sends set_fast_mode and patches both fields from the response", async () => {
    const promise = h.useStore.getState().setFastMode(h.TAB, true);
    const cmd = h.sent[0]!.cmd;
    expect(cmd).toMatchObject({ type: "set_fast_mode", enabled: true });
    h.respond(h.TAB, cmd, { enabled: true, active: true });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.session.fastModeEnabled).toBe(true);
    expect(h.useStore.getState().rpc[h.TAB]!.session.fastModeActive).toBe(true);
  });

  it("a declined enable stores enabled-true-active-false, and a same-value retry still sends", async () => {
    const first = h.useStore.getState().setFastMode(h.TAB, true);
    h.respond(h.TAB, h.sent[0]!.cmd, { enabled: true, active: false });
    await first;
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.fastModeEnabled).toBe(true);
    expect(session.fastModeActive).toBe(false);
    // The declined retry IS a same-value enable: it must not be skipped.
    const retry = h.useStore.getState().setFastMode(h.TAB, true);
    expect(h.sent.at(-1)!.cmd).toMatchObject({ type: "set_fast_mode", enabled: true });
    h.respond(h.TAB, h.sent.at(-1)!.cmd, { enabled: true, active: true });
    await retry;
    expect(h.useStore.getState().rpc[h.TAB]!.session.fastModeActive).toBe(true);
  });

  it("a Fireworks disable stores the provider-tier active truth alongside enabled-false", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), fastModeEnabled: true, fastModeActive: true },
        }),
      },
    });
    const promise = h.useStore.getState().setFastMode(h.TAB, false);
    h.respond(h.TAB, h.sent[0]!.cmd, { enabled: false, active: true });
    await promise;
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.fastModeEnabled).toBe(false);
    expect(session.fastModeActive).toBe(true);
  });

  it("an unavailable-model failure records the command and leaves the state untouched", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), fastModeEnabled: false, fastModeActive: false },
        }),
      },
    });
    const promise = h.useStore.getState().setFastMode(h.TAB, true);
    h.respond(
      h.TAB,
      h.sent[0]!.cmd,
      "Fast mode is unavailable for the current model.",
      false,
    );
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toMatchObject({
      command: "set_fast_mode",
      fatal: false,
    });
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.fastModeEnabled).toBe(false);
    expect(session.fastModeActive).toBe(false);
  });

  it("typing /fast refreshes state so the chip converges without a frame", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: [{ name: "fast", description: "" }],
        }),
      },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/fast");
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await h.flushMicrotasks();
    const state = h.sent.find((s) => s.cmd.type === "get_state");
    expect(state).toBeDefined();
    h.respond(h.TAB, state!.cmd, { fastModeEnabled: true, fastModeActive: true });
    const stats = h.sent.find((s) => s.cmd.type === "get_session_stats");
    if (stats !== undefined) h.respond(h.TAB, stats.cmd, {});
    await promise;
    const session = h.useStore.getState().rpc[h.TAB]!.session;
    expect(session.fastModeEnabled).toBe(true);
    expect(session.fastModeActive).toBe(true);
  });
});

describe("runShellCommand (issue #678)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("sends the bash frame and settles the shell row done from the response", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "echo hello");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "bash", command: "echo hello" });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "shell",
      command: "echo hello",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { exitCode: 0, output: "hello\n", cancelled: false });
    await promise;
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "shell",
      status: "done",
      output: "hello\n",
      exitCode: 0,
    });
  });

  it("settles done with the failing exit code — the command ran", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "false");
    h.respond(h.TAB, h.sent[0]!.cmd, { exitCode: 3, output: "" });
    await promise;
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "shell",
      status: "done",
      exitCode: 3,
    });
  });

  it("settles cancelled from a cancelled response, without an exit code", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "sleep 45");
    h.respond(h.TAB, h.sent[0]!.cmd, {
      cancelled: true,
      output: "[Command cancelled]\n",
    });
    await promise;
    await h.flushMicrotasks();
    const row = h.useStore.getState().rpc[h.TAB]!.items.at(-1)!;
    if (row.kind !== "shell") throw new Error("expected a shell item");
    expect(row).toMatchObject({ kind: "shell", status: "cancelled" });
    expect(row.exitCode).toBeUndefined();
  });

  it("settles failed with omp's error text and paints no session banner", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "echo hi");
    h.respond(h.TAB, h.sent[0]!.cmd, "bash failed", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "shell",
      status: "failed",
      error: "bash failed",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
  });

  it("caps a huge output with the head-preserving truncation note", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "seq 1 100000");
    h.respond(h.TAB, h.sent[0]!.cmd, { exitCode: 0, output: "x".repeat(70 * 1024) });
    await promise;
    await h.flushMicrotasks();
    const row = h.useStore.getState().rpc[h.TAB]!.items.at(-1)!;
    if (row.kind !== "shell") throw new Error("expected a shell item");
    expect(row).toMatchObject({ status: "done" });
    expect(row.output!.length).toBeLessThan(66 * 1024);
    expect(row).toMatchObject({ output: expect.stringContaining("… output truncated") });
  });

  it("never titles the session and stays quiet on busy", async () => {
    const promise = h.useStore.getState().runShellCommand(h.TAB, "echo hi");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeFalsy();
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBeFalsy();
    h.respond(h.TAB, h.sent[0]!.cmd, { exitCode: 0, output: "hi\n" });
    await promise;
    await h.flushMicrotasks();
  });

  it("abortShellCommands sends abort_bash", async () => {
    const promise = h.useStore.getState().abortShellCommands(h.TAB);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "abort_bash" });
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
  });

  it("sends nothing when the tab cannot take commands", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "starting" }) } });
    await h.useStore.getState().runShellCommand(h.TAB, "echo hi");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(0);
  });
});

describe("shareSession (issue #679)", () => {
  /** The per-install first-share privacy flag, seen. */
  const seenPrivacy = (): void => {
    h.storageMap["omp-ui.sharePrivacySeen"] = "1";
  };

  beforeEach(() => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1"),
      rpc: { [h.TAB]: rpcTabState() },
    });
    h.sent.length = 0;
  });

  it("forwards /share through the slash-command chain when advertised and seen", async () => {
    seenPrivacy();
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ commands: [{ name: "share", description: "" }] }) },
    });
    const promise = h.useStore.getState().shareSession(h.TAB);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/share" });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "share",
      status: "running",
    });
    expect(h.useStore.getState().shareConfirmTab).toBeNull();
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
  });

  it("matches the share command by alias", async () => {
    seenPrivacy();
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: [{ name: "share-session", aliases: ["share"], description: "" }],
        }),
      },
    });
    const promise = h.useStore.getState().shareSession(h.TAB);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/share" });
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
  });

  it("leaves a notice and sends nothing when the command is not advertised", async () => {
    seenPrivacy();
    await h.useStore.getState().shareSession(h.TAB);
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
    expect(h.useStore.getState().rpc[h.TAB]!.items[0]).toMatchObject({
      kind: "notice",
      level: "info",
      text: "this omp session does not offer /share — update omp to publish the share command",
    });
  });

  it("opens the first-share dialog and sends nothing while the flag is unseen", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ commands: [{ name: "share", description: "" }] }) },
    });
    await h.useStore.getState().shareSession(h.TAB);
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().shareConfirmTab).toBe(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(0);
  });

  it("confirmSharePrivacy writes the flag, clears the slot, and forwards once", async () => {
    h.useStore.setState({
      shareConfirmTab: h.TAB,
      rpc: { [h.TAB]: rpcTabState({ commands: [{ name: "share", description: "" }] }) },
    });
    const promise = h.useStore.getState().confirmSharePrivacy(h.TAB);
    expect(h.useStore.getState().shareConfirmTab).toBeNull();
    expect(h.storageMap["omp-ui.sharePrivacySeen"]).toBe("1");
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(1);
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
    // A later share skips the dialog: the flag persisted.
    const later = h.useStore.getState().shareSession(h.TAB);
    h.respond(h.TAB, h.sent.at(-1)!.cmd, { agentInvoked: false });
    await later;
    expect(h.useStore.getState().shareConfirmTab).toBeNull();
  });

  it("cancelSharePrivacy closes without forwarding or persisting", async () => {
    h.useStore.setState({ shareConfirmTab: h.TAB });
    h.useStore.getState().cancelSharePrivacy();
    expect(h.useStore.getState().shareConfirmTab).toBeNull();
    expect(h.sent).toHaveLength(0);
    expect(h.storageMap["omp-ui.sharePrivacySeen"]).toBeUndefined();
  });
});

describe("word prediction (issue #715)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  /** The predict_word frames the bus has sent so far. */
  const predictFrames = (): Array<Record<string, unknown>> =>
    h.sent.filter((s) => s.cmd.type === "predict_word").map((s) => s.cmd);

  it("sends text and cursor, stays off busy, and resolves omp's suffix", async () => {
    const promise = h.useStore.getState().predictWord(h.TAB, "the featu", 9);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "predict_word", text: "the featu", cursor: 9 });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
    h.respond(h.TAB, h.sent[0]!.cmd, { suffix: "res" });
    await expect(promise).resolves.toBe("res");
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it.each([null, ""])("resolves null when omp's suffix is %j", async (suffix) => {
    const promise = h.useStore.getState().predictWord(h.TAB, "the featu", 9);
    h.respond(h.TAB, h.sent[0]!.cmd, { suffix });
    await expect(promise).resolves.toBeNull();
  });

  it("an old omp's unknown-command answer silences prediction until a new process boots", async () => {
    // A dedicated tab id: rpcBooting short-circuits a second boot of one id.
    const tab = `${h.TAB}-predict-reboot`;
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({ state: h.backendState, rpc: { [tab]: rpcTabState() } });

    const first = h.useStore.getState().predictWord(tab, "the featu", 9);
    h.respond(tab, h.sent[0]!.cmd, "Unknown command: predict_word", false);
    await expect(first).resolves.toBeNull();
    h.sent.length = 0;

    await expect(h.useStore.getState().predictWord(tab, "the featu", 9)).resolves.toBeNull();
    h.useStore.getState().sendWordPredictionFeedback(tab, {
      text: "the featu",
      cursor: 9,
      suggestion: "res",
      accepted: true,
    });
    expect(h.sent).toHaveLength(0);

    // A replaced process announces itself with ready; boot it to completion.
    h.useStore.getState().handleRpcFrame(tab, { type: "ready", maxFrameBytes: 1048576 });
    for (let wave = 0; wave < 6; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    }
    expect(h.useStore.getState().rpc[tab]!.status).toBe("ready");

    const probe = h.useStore.getState().predictWord(tab, "the featu", 9);
    expect(predictFrames()).toEqual([
      expect.objectContaining({ type: "predict_word", text: "the featu", cursor: 9 }),
    ]);
    h.respond(tab, predictFrames()[0]!, { suffix: "res" });
    await expect(probe).resolves.toBe("res");
  });

  it("any other failure backs off for 30 s without a transcript row or banner", async () => {
    vi.useFakeTimers();
    try {
      const first = h.useStore.getState().predictWord(h.TAB, "the featu", 9);
      h.respond(h.TAB, h.sent[0]!.cmd, "predict daemon unavailable", false);
      await expect(first).resolves.toBeNull();
      h.sent.length = 0;

      await vi.advanceTimersByTimeAsync(29_999);
      await expect(h.useStore.getState().predictWord(h.TAB, "the featu", 9)).resolves.toBeNull();
      expect(h.sent).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const retry = h.useStore.getState().predictWord(h.TAB, "the featu", 9);
      expect(predictFrames()).toHaveLength(1);
      h.respond(h.TAB, predictFrames()[0]!, { suffix: "res" });
      await expect(retry).resolves.toBe("res");

      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items).toHaveLength(0);
      expect(tab.failure).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sendWordPredictionFeedback sends exactly the id-less feedback frame", () => {
    h.useStore.getState().sendWordPredictionFeedback(h.TAB, {
      text: "the featu",
      cursor: 9,
      suggestion: "res",
      accepted: false,
    });
    expect(h.sent).toEqual([
      {
        tabId: h.TAB,
        cmd: {
          type: "predict_word_feedback",
          text: "the featu",
          cursor: 9,
          suggestion: "res",
          accepted: false,
        },
      },
    ]);
  });

  it("sendWordPredictionFeedback sends nothing while the tab is starting", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "starting" }) } });
    h.useStore.getState().sendWordPredictionFeedback(h.TAB, {
      text: "the featu",
      cursor: 9,
      suggestion: "res",
      accepted: true,
    });
    expect(h.sent).toHaveLength(0);
  });
});
