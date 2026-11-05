// The /council line in a native tab (ADR-0088): an empty launchable roster is
// refused in the transcript with a Council-settings action and nothing leaves
// the tab; every other outcome reaches the council bridge verbatim.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilMember, CouncilRosterView } from "@omp-ui/core/types";
import { t } from "../../lib/i18n";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

function view(members: CouncilMember[]): CouncilRosterView {
  return {
    members,
    instructions: null,
    configWarnings: [],
    global: null,
    project: null,
    effective: members.map((member) => ({ ...member, sourceScope: "project" as const })),
  };
}

const MEMBER: CouncilMember = { name: "alpha", model: "probe/member", instructions: null, enabled: true };

const getCouncilRoster = vi.fn(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async (scopeCwd: string | null): Promise<CouncilRosterView> => view([]),
);
Object.assign(h.mockBackend, { getCouncilRoster });

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

/** Runs a slash line, answering every command it sends with an empty success. */
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

function seed(councilEnabled: boolean): void {
  h.backendState = { ...h.stateWithRecord("sess-1"), councilEnabled };
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

describe("/council in a native tab (ADR-0088)", () => {
  beforeEach(() => {
    getCouncilRoster.mockImplementation(async () => view([]));
    seed(true);
  });

  it("refuses an empty council with a settings action and sends nothing", async () => {
    await runLine("/council x");
    expect(getCouncilRoster).toHaveBeenCalledWith("/p");
    expect(h.sent).toEqual([]);
    expect(commandRows()).toEqual([
      {
        name: "council",
        args: "x",
        status: "failed",
        error: t("council.command.empty"),
        action: "council-settings",
      },
    ]);
  });

  it("forwards the line verbatim when a member can launch", async () => {
    getCouncilRoster.mockImplementation(async () => view([MEMBER]));
    await runLine("/council x");
    expect(allPrompts()).toEqual(["/council x"]);
    expect(commandRows()).toEqual([
      expect.objectContaining({ name: "council", args: "x", status: "done", action: undefined }),
    ]);
  });

  it("forwards the line when the roster cannot be read", async () => {
    getCouncilRoster.mockImplementation(async () => {
      throw new Error("Unknown channel: council:roster");
    });
    await runLine("/council x");
    expect(allPrompts()).toEqual(["/council x"]);
    expect(commandRows()[0]?.action).toBeUndefined();
  });

  it("leaves the line to the advertised path while the council flag is off", async () => {
    seed(false);
    await runLine("/council x");
    expect(getCouncilRoster).not.toHaveBeenCalled();
    expect(allPrompts()).toEqual(["/council x"]);
    expect(commandRows()).toEqual([
      expect.objectContaining({ name: "council", args: "x", status: "done", action: undefined }),
    ]);
  });
});
