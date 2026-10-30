// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetProviderKeysOutcome, FleetUpdateAck } from "@omp-ui/core/fleet";
import type { SessionSummary } from "@omp-ui/core/types";
import { backendState, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  getState: vi.fn(async () => backendState()),
  terminateSession: vi.fn(async () => {}),
  switchMode: vi.fn(async () => {}),
  setSkipTerminateConfirmation: vi.fn(async () => {}),
  removeProject: vi.fn(async () => {}),
  fleetRolloutProviderKeys: vi.fn(
    async (): Promise<FleetProviderKeysOutcome> => ({ status: "accepted", installed: [], failed: [] }),
  ),
  fleetUpdateMachine: vi.fn(
    async (): Promise<FleetUpdateAck> => ({ status: "accepted", jobId: "job-1" }),
  ),
};
Object.assign(window, { ompBackend: backendMock });
// Tripwire, not automation: the old dialogs were native, and a surviving
// native call would hide itself from these DOM assertions (issue #373).
const nativeAlert = vi.fn();
const nativeConfirm = vi.fn(() => true);
window.alert = nativeAlert;
window.confirm = nativeConfirm;

// Dynamic imports: store.ts captures the mocked bridge at module load.
const { useStore } = await import("../store");
const { AppFeedback } = await import("./AppFeedback");

const TAB = "tab-fb-1";

const PROJECT = {
  path: "/p",
  name: "p",
  addedAt: "t",
  lastModel: null,
  lastThinkingLevel: null,
  lastAdvisor: null,
  lastAdvisorModel: null,
  defaultModel: null,
  defaultAdvisorModel: null,
  browserClock: false,
  reviewRoster: null,
  knowledgeHome: null,
  repositoryKey: null,
};

function record(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId: TAB,
    sessionId: "s-1",
    lineageDir: "omp-ui--p--s-1",
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui",
    worktree: null,
    planImplementationSource: null, experiment: null, fleet: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 private: false,
 chat: false,
 askSource: null,
    cachedTitle: "Running task",
    cachedModified: "t",
    title: "Running task",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function seed(): void {
  useStore.setState({
    state: backendState({ projects: [{ project: PROJECT, sessions: [record()] }] }),
    tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    activeTabId: TAB,
    lifecycleConfirmation: null,
    errorNotices: [],
    infoNotices: [],
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mounts the feedback host and drains the overlay hook's rAF focus pass. */
async function render(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AppFeedback />));
  await settle();
}

/** Re-render pass + the overlay's rAF focus of a newly keyed dialog. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="alertdialog"]');

const buttonIn = (text: string): HTMLButtonElement => {
  const found = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found, `button "${text}"`).toBeDefined();
  return found!;
};

const pressEscape = (): void => {
  const node = dialog()!;
  act(() => {
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
};

beforeEach(() => {
  seed();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
  expect(nativeAlert).not.toHaveBeenCalled();
  expect(nativeConfirm).not.toHaveBeenCalled();
});

describe("stop confirmation is a drivable DOM dialog", () => {
  it("stages on the stop action, Cancel from the DOM declines", async () => {
    await render();
    expect(dialog()).toBeNull();

    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Stop the agent?");
    expect(dialog()!.textContent).toContain("Running task"); // the captured target
    expect(backendMock.terminateSession).not.toHaveBeenCalled();
    // Cancel owns the initial focus: accepting must be a deliberate act.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
    expect(backendMock.terminateSession).not.toHaveBeenCalled();
  });

  it("Escape cancels before acceptance and Confirm dispatches the stop once", async () => {
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    pressEscape();
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(backendMock.terminateSession).not.toHaveBeenCalled();

    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    await act(async () => {
      buttonIn("Stop agent").click();
    });
    expect(backendMock.terminateSession).toHaveBeenCalledWith(TAB);
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("while an accepted stop is in flight the dialog blocks and dispatches once", async () => {
    const stop = deferred<void>();
    backendMock.terminateSession.mockReturnValueOnce(stop.promise);
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    const id = useStore.getState().lifecycleConfirmation!.id;
    const change = useStore.getState().confirmLifecycleAction(id);
    await settle();

    // Both buttons disabled; Escape is a no-op while busy: an accepted
    // backend command is not cancellable, and re-activation must not fire.
    expect(buttonIn("Cancel").disabled).toBe(true);
    expect(buttonIn("Working…").disabled).toBe(true);
    pressEscape();
    expect(useStore.getState().lifecycleConfirmation).toMatchObject({ id, busy: true });
    await act(async () => {
      await useStore.getState().confirmLifecycleAction(id);
    });
    expect(backendMock.terminateSession).toHaveBeenCalledTimes(1);

    stop.resolve(undefined);
    await act(async () => {
      await change;
    });
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });
});

// The terminate dialog's opt-out row (issue #925): the checkbox persists the
// setting before dispatching, and only on accept.
describe("stop-confirmation opt-out checkbox (issue #925)", () => {
  const checkboxInDialog = (): HTMLInputElement | null =>
    dialog()?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

  it("offers the opt-out and persists it before dispatching the stop", async () => {
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    const checkbox = checkboxInDialog();
    expect(checkbox).not.toBeNull();
    expect(dialog()!.textContent).toContain("Do not show this warning again");
    expect(checkbox!.checked).toBe(false);

    act(() => checkbox!.click());
    expect(checkbox!.checked).toBe(true);

    await act(async () => {
      buttonIn("Stop agent").click();
    });
    expect(backendMock.setSkipTerminateConfirmation).toHaveBeenCalledWith(true);
    expect(backendMock.terminateSession).toHaveBeenCalledWith(TAB);
    // Persist before dispatch: a concurrent stop must see the saved setting.
    expect(backendMock.setSkipTerminateConfirmation.mock.invocationCallOrder[0]).toBeLessThan(
      backendMock.terminateSession.mock.invocationCallOrder[0],
    );
  });

  it("does not persist when the dialog is cancelled with the box checked", async () => {
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    act(() => checkboxInDialog()!.click());
    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(backendMock.setSkipTerminateConfirmation).not.toHaveBeenCalled();
    expect(backendMock.terminateSession).not.toHaveBeenCalled();
  });

  it("offers no checkbox on a mode-switch confirmation", async () => {
    await render();
    await act(async () => {
      await useStore.getState().switchMode(TAB, "pty");
    });
    await settle();
    expect(dialog()!.textContent).toContain("Switch session mode?");
    expect(checkboxInDialog()).toBeNull();
  });

  it("resets the checkbox when a second stop is staged", async () => {
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    act(() => checkboxInDialog()!.click());
    await act(async () => {
      buttonIn("Cancel").click();
    });

    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    expect(checkboxInDialog()!.checked).toBe(false);
  });
});

describe("mode-switch and project-removal dialogs", () => {
  it("names the target mode, then routes removal decisions the same way", async () => {
    await render();
    await act(async () => {
      await useStore.getState().switchMode(TAB, "pty");
    });
    await settle();
    expect(dialog()!.textContent).toContain("Switch session mode?");
    expect(dialog()!.textContent).toContain("terminal");
    await act(async () => {
      buttonIn("Restart session").click();
    });
    expect(backendMock.switchMode).toHaveBeenCalledWith(TAB, "pty");

    await act(async () => {
      await useStore.getState().removeProject("/p");
    });
    await settle();
    expect(dialog()!.textContent).toContain("Remove project?");
    expect(dialog()!.textContent).toContain("/p");
    expect(backendMock.removeProject).not.toHaveBeenCalled();
    await act(async () => {
      buttonIn("Remove project").click();
    });
    expect(backendMock.removeProject).toHaveBeenCalledWith("/p");
  });
});

describe("error notices", () => {
  it("reads the full backend text in order and restores the hidden confirmation", async () => {
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await render();
    useStore.setState({
      errorNotices: [
        { id: "e1", message: "first: no such file" },
        {
          id: "e2",
          message: "Could not enable the advisor: EPERM: locked\n\nThe agent has stopped.",
        },
      ],
    });
    await settle();

    // The error outranks the pending confirmation — without dropping it.
    expect(dialog()!.textContent).toContain("Could not complete the action");
    expect(dialog()!.textContent).toContain("first: no such file");
    // A DOM notice never blocks the renderer's event loop: a queued task runs.
    let laterRan = false;
    await act(async () => {
      setTimeout(() => {
        laterRan = true;
      }, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(laterRan).toBe(true);

    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    expect(dialog()!.textContent).toContain("EPERM: locked");
    expect(dialog()!.textContent).toContain("The agent has stopped.");

    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    // Both notices acknowledged: the still-pending decision is back.
    expect(dialog()!.textContent).toContain("Stop the agent?");
    expect(useStore.getState().lifecycleConfirmation).not.toBeNull();

    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(useStore.getState().errorNotices).toEqual([]);
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });
});

describe("credential-carry gate and success notices (issue #888)", () => {
  it("gates the carry on a plaintext warning naming the target, cancel touches nothing", async () => {
    await render();
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "carry-auth",
        action: "to-instance",
        targetLabel: "box-b",
        instanceId: "i-1",
      });
    });
    await settle();
    expect(dialog()!.textContent).toContain("Carry credentials?");
    expect(dialog()!.textContent).toContain("plaintext");
    expect(dialog()!.textContent).toContain("box-b");
    // Cancel is the deliberate default; nothing has been asked of main.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("renders successes in order under the error queue and restores the hidden confirmation", async () => {
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await render();
    useStore.setState({
      errorNotices: [{ id: "e1", message: "pack blew up" }],
      infoNotices: [
        { id: "n1", message: "Session migrated: “a” now lives at the target" },
        { id: "n2", message: "Sign-ins carried to box-b." },
      ],
    });
    await settle();

    // Errors outrank successes; successes outrank the pending decision.
    expect(dialog()!.textContent).toContain("pack blew up");
    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    expect(dialog()!.textContent).toContain("Session migrated");
    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    expect(dialog()!.textContent).toContain("Sign-ins carried to box-b.");
    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    expect(dialog()!.textContent).toContain("Stop the agent?");
    expect(useStore.getState().infoNotices).toEqual([]);

    await act(async () => {
      buttonIn("Cancel").click();
    });
  });
});

describe("Provider key rollout gate (issue #905)", () => {
  const INSTANCE = {
    id: "i-1",
    nickname: "studio",
    url: "http://studio.tailnet:4677",
    status: "joined" as const,
    error: null,
    version: "1.0.0",
    projects: [],
    modelFavorites: [],
  };

  function stageRollout(encrypted: boolean): void {
    useStore.setState({ state: backendState({ remoteInstances: [INSTANCE] }) });
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "rollout-keys",
        instanceId: "i-1",
        targetLabel: "studio",
        envNames: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        encrypted,
      });
    });
  }

  it("warns about plain HTTP, sends env names only, and posts the done notice", async () => {
    backendMock.fleetRolloutProviderKeys.mockResolvedValueOnce({
      status: "accepted",
      installed: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      failed: [],
    });
    await render();
    stageRollout(false);
    await settle();
    expect(dialog()!.textContent).toContain("Roll out Provider keys?");
    expect(dialog()!.textContent).toContain("sends 2 Provider keys from this computer to studio");
    expect(dialog()!.textContent).toContain("unencrypted HTTP");

    await act(async () => {
      buttonIn("Roll out keys").click();
    });
    await settle();
    expect(backendMock.fleetRolloutProviderKeys).toHaveBeenCalledWith("i-1", [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(useStore.getState().errorNotices).toEqual([]);
    expect(useStore.getState().infoNotices.map((n) => n.message)).toEqual([
      "2 Provider keys stored on studio. Restart its running sessions to use them.",
    ]);
  });

  it("names HTTPS when the join is encrypted, and reports per-key failures beside the notice", async () => {
    backendMock.fleetRolloutProviderKeys.mockResolvedValueOnce({
      status: "accepted",
      installed: ["ANTHROPIC_API_KEY"],
      failed: [{ envName: "OPENAI_API_KEY", reason: "no OS credential store" }],
    });
    await render();
    stageRollout(true);
    await settle();
    expect(dialog()!.textContent).toContain("over HTTPS");

    await act(async () => {
      buttonIn("Roll out keys").click();
    });
    await settle();
    expect(useStore.getState().infoNotices.map((n) => n.message)).toEqual([
      "1 Provider key stored on studio. Restart its running sessions to use it.",
    ]);
    expect(useStore.getState().errorNotices.map((n) => n.message)).toEqual([
      "Some keys were not stored on studio: OPENAI_API_KEY: no OS credential store",
    ]);
  });

  it("posts only the error when no key was stored", async () => {
    backendMock.fleetRolloutProviderKeys.mockResolvedValueOnce({
      status: "accepted",
      installed: [],
      failed: [{ envName: "OPENAI_API_KEY", reason: "no OS credential store" }],
    });
    await render();
    stageRollout(true);
    await settle();
    await act(async () => {
      buttonIn("Roll out keys").click();
    });
    await settle();
    expect(useStore.getState().infoNotices).toEqual([]);
    expect(useStore.getState().errorNotices.map((n) => n.message)).toEqual([
      "Some keys were not stored on studio: OPENAI_API_KEY: no OS credential store",
    ]);
  });

  it("surfaces a refused rollout as an error notice", async () => {
    backendMock.fleetRolloutProviderKeys.mockResolvedValueOnce({
      status: "refused",
      reason: "fleet exec is off on this machine",
    });
    await render();
    stageRollout(true);
    await settle();
    await act(async () => {
      buttonIn("Roll out keys").click();
    });
    await settle();
    expect(useStore.getState().infoNotices).toEqual([]);
    expect(useStore.getState().errorNotices.map((n) => n.message)).toEqual([
      "fleet exec is off on this machine",
    ]);
    expect(dialog()!.textContent).toContain("fleet exec is off on this machine");
  });
});

describe("Fleet remote version update gates (slice H)", () => {
  const MEMBER = {
    id: "inst-a",
    nickname: "studio",
    url: "https://studio.tailnet:4677",
    status: "joined" as const,
    error: null,
    version: "1.0.0",
    projects: [],
    modelFavorites: [],
  };

  function seedMember(url: string): void {
    useStore.setState({ state: backendState({ remoteInstances: [{ ...MEMBER, url }] }) });
  }

  it("names member and a → b version hop, latest when null, and the live-session binary rule", async () => {
    seedMember("https://studio.tailnet:4677");
    await render();
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-update-omp", machineKey: "inst-a", machineNickname: "studio",
        currentVersion: "18.12.0", targetVersion: null,
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).toContain("Update omp remotely?");
    expect(body).toContain("sends studio a request over HTTPS");
    expect(body).toContain("from 18.12.0 to latest");
    // The transport note rides the join URL, like rollout's (#905).
    expect(body).toContain("over HTTPS");
    expect(body).toContain("keep the binary they started with until they restart");

    await act(async () => {
      buttonIn("Update omp").click();
    });
    await settle();
    expect(backendMock.fleetUpdateMachine).toHaveBeenCalledWith("inst-a", {
      target: "omp", action: "stage", version: null, allowLiveSessions: false,
    });
    // Quiet success: no dialog stays open and no notice replaces it.
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(useStore.getState().infoNotices).toEqual([]);
    expect(useStore.getState().errorNotices).toEqual([]);
  });

  it("names plain HTTP when the member joins unencrypted", async () => {
    await render();
    seedMember("http://studio.tailnet:4677");
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-update-omp", machineKey: "inst-a", machineNickname: "studio",
        currentVersion: null, targetVersion: "18.13.1",
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).toContain("unencrypted HTTP");
    // Unknown current version is spelled out; the hop still names both ends.
    expect(body).toContain("from an unknown version to 18.13.1");
  });

  it("stages the app update naming the version and the quit-time install", async () => {
    await render();
    seedMember("https://studio.tailnet:4677");
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-stage-app", machineKey: "inst-a", machineNickname: "studio", version: "1.4.0",
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).toContain("Stage the omp-ui app update?");
    expect(body).toContain("sends studio a request over HTTPS");
    expect(body).toContain("omp-ui app update (1.4.0)");
    expect(body).toContain("Nothing installs until the update is applied the next time that machine quits");

    await act(async () => {
      buttonIn("Stage update").click();
    });
    await settle();
    expect(backendMock.fleetUpdateMachine).toHaveBeenCalledWith("inst-a", {
      target: "app", action: "stage", version: "1.4.0", allowLiveSessions: false,
    });
  });

  it("names the live-session count when applying and offers Install when I quit", async () => {
    await render();
    seedMember("https://studio.tailnet:4677");
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-apply-app", machineKey: "inst-a", machineNickname: "studio", liveSessions: 3,
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).toContain("3 live session(s) run on studio");
    expect(body).toContain("the next time it quits");

    await act(async () => {
      buttonIn("Install when I quit").click();
    });
    await settle();
    expect(backendMock.fleetUpdateMachine).toHaveBeenCalledWith("inst-a", {
      target: "app", action: "apply", version: null, allowLiveSessions: true,
    });
  });

  it("drops the live-session sentence and flag when nothing runs there", async () => {
    await render();
    seedMember("https://studio.tailnet:4677");
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-apply-app", machineKey: "inst-a", machineNickname: "studio", liveSessions: 0,
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).not.toContain("live session");
    expect(body).toContain("arms studio to install its staged omp-ui update");

    await act(async () => {
      buttonIn("Install when I quit").click();
    });
    await settle();
    expect(backendMock.fleetUpdateMachine).toHaveBeenCalledWith("inst-a", {
      target: "app", action: "apply", version: null, allowLiveSessions: false,
    });
  });

  it("speaks locally without a transport sentence for this computer", async () => {
    await render();
    act(() => {
      useStore.getState().stageLifecycleConfirmation({
        kind: "fleet-update-omp", machineKey: "local", machineNickname: null,
        currentVersion: "18.12.0", targetVersion: null,
      });
    });
    await settle();
    const body = dialog()!.textContent!;
    expect(body).toContain("This asks this computer to update its own omp binary from 18.12.0 to latest");
    expect(body).not.toContain("HTTPS");
    expect(body).not.toContain("unencrypted");
  });
});
