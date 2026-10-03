// Rewind/tree store tests (issue #680) on the shared harness.
import { beforeEach, describe, expect, it } from "vitest";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

describe("rewind to a prompt (issue #680)", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          items: [
            { kind: "user", id: "u1", text: "first prompt" },
            { kind: "assistant", id: "a1", text: "answer one", thinking: "", streaming: false },
            { kind: "user", id: "u2", text: "second prompt" },
            { kind: "assistant", id: "a2", text: "answer two", thinking: "", streaming: false },
          ],
        }),
      },
    });
    h.sent.length = 0;
    answered.length = 0;
  });

  /** get_entries data for the two-prompt linear branch, leaf e4. */
  const ENTRIES = {
    entries: [
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "first prompt" }] } },
      { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "answer one" }] } },
      { type: "message", id: "e3", parentId: "e2", message: { role: "user", content: [{ type: "text", text: "second prompt" }] } },
      { type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } },
    ],
    leafId: "e4",
  };

  /** Answers every pending command from a per-type table until quiet,
   *  recording everything that left the store in `answered`. */
  const answered: Array<Record<string, unknown>> = [];
  const drive = async (
    responses: Record<string, { data?: unknown; success?: boolean }>,
  ): Promise<void> => {
    for (let wave = 0; wave < 6; wave++) {
      await h.flushMicrotasks();
      const pending = h.sent.splice(0);
      if (pending.length === 0) return;
      for (const { tabId, cmd } of pending) {
        answered.push(cmd);
        const r = responses[String(cmd.type)] ?? {};
        h.respond(tabId, cmd, r.data ?? {}, r.success ?? true);
      }
    }
  };

  it("stages through get_entries correlation: the click resolves to a leaf-path entry", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 0, false);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "get_entries" });
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    expect(h.useStore.getState().lifecycleConfirmation).toMatchObject({
      kind: "rewind",
      tabId: h.TAB,
      entryId: "e1",
      // Rows strictly after the clicked prompt: a1, u2, a2.
      laterTurns: 3,
      editResend: false,
    });
  });

  it("confirm dispatches branch with the correlated id and reloads history", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 0, false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
    await drive({
      branch: { data: { text: "first prompt", cancelled: false } },
      get_messages: {
        data: {
          messages: [
            { role: "user", content: [{ type: "text", text: "first prompt" }] },
          ],
        },
      },
      get_state: { data: {} },
    });
    await confirmed;
    expect(answered.find((cmd) => cmd.type === "branch")).toMatchObject({
      type: "branch",
      entryId: "e1",
    });
    // The transcript became the rewound branch's context, plus the info row.
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items.map((i) => i.kind)).toEqual(["user", "notice"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "first prompt" });
  });

  it("busy refuses without sending anything", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ status: "running" }) },
    });
    await h.useStore.getState().stageRewind(h.TAB, 0, false);
    expect(answered).toHaveLength(0);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.errorMessages()).toEqual([
      "Rewind needs a live, idle native session. Wait for the turn to finish (or stop it), then try again.",
    ]);

    h.sent.length = 0;
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      rpc: { [h.TAB]: rpcTabState() },
    });
    await h.useStore.getState().stageRewind(h.TAB, 0, false);
    expect(h.sent).toHaveLength(0);
  });

  it("a failed correlation reports the error and stages nothing", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 1, false);
    // Same length, different text at position 1 — drift must refuse.
    await drive({
      get_entries: {
        data: {
          entries: ENTRIES.entries.map((e) =>
            e.id === "e3"
              ? {
                  ...e,
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "something else" }],
                  },
                }
              : e,
          ),
          leafId: "e4",
        },
      },
    });
    await staging;
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.errorMessages()[0]).toContain(
      "Could not match this prompt to a session entry",
    );
    expect(answered.find((cmd) => cmd.type === "branch")).toBeUndefined();
  });

  it("an older omp without get_entries degrades quietly: notice, no failure panel", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 0, false);
    await drive({ get_entries: { success: false, data: "unknown command" } });
    await staging;
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.errorMessages()[0]).toContain("Could not match this prompt");
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
  });

  it("edit and resend prefills the composer with the visible prompt text", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 1, true);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    expect(confirmation).toMatchObject({
      kind: "rewind",
      entryId: "e3",
      editResend: true,
      laterTurns: 1,
    });
    const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
    await drive({
      branch: { data: { text: "second prompt", cancelled: false } },
      get_messages: { data: { messages: [] } },
      get_state: { data: {} },
    });
    await confirmed;
    expect(h.useStore.getState().rpc[h.TAB]!.composerQueue).toEqual({
      images: [],
      text: ["second prompt"],
    });
    // The done-notice row carries the "still in the file" note.
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "notice",
      level: "info",
      text: "rewound — later turns stay in the session file as another branch",
    });
  });

  it("a cancelled branch response reloads nothing", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 0, false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
    await h.flushMicrotasks();
    // The branch command went out; answer it cancelled before drive().
    const branch = h.sent.splice(0).find((s) => s.cmd.type === "branch")!;
    h.respond(h.TAB, branch.cmd, { text: "first prompt", cancelled: true });
    await drive({ get_state: { data: {} } });
    await confirmed;
    // cancelled: reloadHistory never ran — no get_messages went out.
    expect(h.sent.find((s) => s.cmd.type === "get_messages")).toBeUndefined();
    // And no prefill leaks into a later edit-and-resend.
    expect(h.useStore.getState().rpc[h.TAB]!.composerQueue).toBeUndefined();
  });

  it("stageRewindEntry takes the id from the tree and refuses a non-user entry", async () => {
    const staging = h.useStore.getState().stageRewindEntry(h.TAB, "e1", false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    expect(h.useStore.getState().lifecycleConfirmation).toMatchObject({
      kind: "rewind",
      entryId: "e1",
      laterTurns: 3,
    });
    h.useStore.setState({ lifecycleConfirmation: null });
    const assistant = h.useStore.getState().stageRewindEntry(h.TAB, "e2", false);
    await drive({ get_entries: { data: ENTRIES } });
    await assistant;
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.errorMessages()[0]).toContain("Could not match this prompt");
  });

  it("stageNavigate counts the discarded leaf tail and stages the bridge jump", async () => {
    const branching = {
      entries: [
        ...ENTRIES.entries,
        // A sibling rewind under e2.
        {
          type: "message",
          id: "e5",
          parentId: "e2",
          message: { role: "user", content: [{ type: "text", text: "other branch" }] },
        },
      ],
      leafId: "e4",
    };
    const staging = h.useStore.getState().stageNavigate(h.TAB, "e5", false);
    await drive({ get_entries: { data: branching } });
    await staging;
    // Jumping from leaf e4 to sibling e5 discards e3 and e4.
    expect(h.useStore.getState().lifecycleConfirmation).toMatchObject({
      kind: "navigate",
      entryId: "e5",
      summarize: false,
      laterTurns: 2,
    });
  });

  it("performNavigate dispatches the hidden command and settles from the published snapshot", async () => {
    const snapshot = (revision: number, ok: boolean) =>
      JSON.stringify({
        available: true,
        revision,
        leafId: "e4",
        activePath: ["e1"],
        nodes: [],
        navigation: {
          entryId: "e5",
          ok,
          ...(ok ? {} : { error: "Entry e5 not found" }),
        },
      });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          extensionStatus: { "omp-ui:tree": snapshot(1, false) },
        }),
      },
    });
    const staging = h.useStore.getState().stageNavigate(h.TAB, "e5", false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
    await h.flushMicrotasks();
    const promptCmd = h.sent.find((s) => s.cmd.type === "prompt")!;
    expect(promptCmd.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-tree navigate e5",
    });
    // The bridge's publish answers for the jump — the ack alone settles nothing.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u1",
      method: "setStatus",
      statusKey: "omp-ui:tree",
      statusText: snapshot(2, true),
    });
    await drive({
      prompt: {},
      get_messages: { data: { messages: [] } },
      get_state: { data: {} },
    });
    await confirmed;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "notice",
      text: "navigated — the transcript shows the branch you jumped to",
    });
    expect(h.errorMessages()).toHaveLength(0);
  });

  it("a failed navigate result reports the bridge's error and reloads nothing", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          extensionStatus: {
            "omp-ui:tree": JSON.stringify({
              available: true,
              revision: 1,
              leafId: "e4",
              activePath: [],
              nodes: [],
            }),
          },
        }),
      },
    });
    const staging = h.useStore.getState().stageNavigate(h.TAB, "e5", false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
    await h.flushMicrotasks();
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u1",
      method: "setStatus",
      statusKey: "omp-ui:tree",
      statusText: JSON.stringify({
        available: true,
        revision: 2,
        leafId: "e4",
        activePath: [],
        nodes: [],
        navigation: { entryId: "e5", ok: false, error: "Entry e5 not found" },
      }),
    });
    await drive({ prompt: {} });
    await confirmed;
    expect(h.errorMessages()).toEqual(["Entry e5 not found"]);
    expect(h.sent.find((s) => s.cmd.type === "get_messages")).toBeUndefined();
  });

  it("a rewind confirmation on a tab whose process died dispatches nothing", async () => {
    const staging = h.useStore.getState().stageRewind(h.TAB, 0, false);
    await drive({ get_entries: { data: ENTRIES } });
    await staging;
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.sent.find((s) => s.cmd.type === "branch")).toBeUndefined();
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("reloadHistory replaces items wholesale", async () => {
    const loading = h.useStore.getState().reloadHistory(h.TAB);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "get_messages" });
    h.respond(h.TAB, h.sent[0]!.cmd, {
      messages: [
        { role: "user", content: [{ type: "text", text: "from disk" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
      ],
    });
    await loading;
    expect(h.useStore.getState().rpc[h.TAB]!.items.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
    ]);
  });

  describe("fork from a tree row (issue #717)", () => {
    it("stageForkEntry validates the entry and stages the fork confirmation", async () => {
      const staging = h.useStore.getState().stageForkEntry(h.TAB, "e1");
      expect(h.sent[0]!.cmd).toMatchObject({ type: "get_entries" });
      await drive({ get_entries: { data: ENTRIES } });
      await staging;
      expect(h.useStore.getState().lifecycleConfirmation).toMatchObject({
        kind: "fork",
        tabId: h.TAB,
        entryId: "e1",
        laterTurns: 3,
      });
    });

    it("a non-message entry reports the fork-entry error and stages nothing", async () => {
      const staging = h.useStore.getState().stageForkEntry(h.TAB, "e2");
      await drive({ get_entries: { data: ENTRIES } });
      await staging;
      expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
      expect(h.errorMessages()[0]).toContain("not a message entry");
    });

    it("a busy tab reports the fork-busy error and sends nothing", async () => {
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
      await h.useStore.getState().stageForkEntry(h.TAB, "e1");
      expect(h.sent).toHaveLength(0);
      expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
      expect(h.errorMessages()).toEqual([
        "Fork needs a live, idle native session. Wait for the turn to finish (or stop it), then try again.",
      ]);
    });

    it("confirm dispatches fork and reloads with the done notice", async () => {
      const staging = h.useStore.getState().stageForkEntry(h.TAB, "e1");
      await drive({ get_entries: { data: ENTRIES } });
      await staging;
      const confirmation = h.useStore.getState().lifecycleConfirmation!;
      const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
      await drive({
        fork: { data: { cancelled: false } },
        get_messages: {
          data: {
            messages: [
              { role: "user", content: [{ type: "text", text: "first prompt" }] },
            ],
          },
        },
        get_state: { data: {} },
      });
      await confirmed;
      expect(answered.find((cmd) => cmd.type === "fork")).toMatchObject({
        type: "fork",
        entryId: "e1",
      });
      const items = h.useStore.getState().rpc[h.TAB]!.items;
      expect(items.map((i) => i.kind)).toEqual(["user", "notice"]);
      expect(items.at(-1)).toMatchObject({
        kind: "notice",
        level: "info",
        text:
          "forked — this tab continues in a new session file up to that prompt; the original stays on disk unchanged",
      });
    });

    it("a cancelled fork reloads nothing and appends the cancelled notice", async () => {
      const staging = h.useStore.getState().stageForkEntry(h.TAB, "e1");
      await drive({ get_entries: { data: ENTRIES } });
      await staging;
      const confirmation = h.useStore.getState().lifecycleConfirmation!;
      const confirmed = h.useStore.getState().confirmLifecycleAction(confirmation.id);
      await h.flushMicrotasks();
      const fork = h.sent.splice(0).find((s) => s.cmd.type === "fork")!;
      h.respond(h.TAB, fork.cmd, { cancelled: true });
      await drive({});
      await confirmed;
      expect(h.sent.find((s) => s.cmd.type === "get_messages")).toBeUndefined();
      expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
        kind: "notice",
        text: "the fork was cancelled by a session hook — nothing moved",
      });
    });

    it("a fork confirmation on a tab whose process died dispatches nothing", async () => {
      const staging = h.useStore.getState().stageForkEntry(h.TAB, "e1");
      await drive({ get_entries: { data: ENTRIES } });
      await staging;
      const confirmation = h.useStore.getState().lifecycleConfirmation!;
      h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
      await h.useStore.getState().confirmLifecycleAction(confirmation.id);
      expect(h.sent.find((s) => s.cmd.type === "fork")).toBeUndefined();
      expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    });
  });
});
