// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateState } from "@omp-ui/core/types";
import { idleHostUpdateState } from "@omp-ui/core/host-update-state";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// store.ts captures the backend at module load, so install the mock before dynamically importing
// either the store or the card. No desktop adapter: the host card must not need one.
const backendMock = {
  checkHostUpdate: vi.fn(async () => idleHostUpdateState("1.0.0")),
  downloadHostUpdate: vi.fn(async () => {}),
  deferHostUpdate: vi.fn(async () => idleHostUpdateState("1.0.0")),
  applyHostUpdate: vi.fn(async () => {}),
  rollbackHostUpdate: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { HostUpdateCard } = await import("./HostUpdateCard");

function hostUpdate(patch: Partial<HostUpdateState>): HostUpdateState {
  return { ...idleHostUpdateState("1.0.0"), ...patch };
}

function seed(patch: Partial<HostUpdateState>): void {
  useStore.setState({
    state: backendState({ hostVersion: "1.0.0", hostProtocol: 2, hostUpdate: hostUpdate(patch) }),
  });
}

let root: Root | null = null;

function renderCard(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<HostUpdateCard />));
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === text,
    ) ?? null
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  useStore.setState({ state: null });
});

describe("HostUpdateCard", () => {
  it("renders nothing before the first state read", () => {
    useStore.setState({ state: null });
    renderCard();
    expect(document.body.textContent).toBe("");
  });

  it("names the host version and protocol and offers only a check while idle", async () => {
    seed({});
    renderCard();
    expect(document.body.textContent).toContain("1.0.0 · protocol 2");
    expect(document.body.textContent).toContain("no check has run yet");
    expect(buttonWithText("Download")).toBeNull();
    expect(buttonWithText("Apply now")).toBeNull();
    expect(buttonWithText("Defer")).toBeNull();
    await click(buttonWithText("Check now")!);
    expect(backendMock.checkHostUpdate).toHaveBeenCalledOnce();
  });

  it("offers the download once a newer version is available", async () => {
    seed({ status: "available", latestVersion: "1.1.0" });
    renderCard();
    expect(document.body.textContent).toContain("1.1.0 available");
    await click(buttonWithText("Download")!);
    expect(backendMock.downloadHostUpdate).toHaveBeenCalledOnce();
  });

  it("shows download progress and blocks a concurrent check", () => {
    seed({ status: "downloading", latestVersion: "1.1.0", progress: 42 });
    renderCard();
    expect(document.body.textContent).toContain("downloading 1.1.0…");
    expect(document.body.querySelector<HTMLElement>("[style*='width: 42%']")).not.toBeNull();
    expect(buttonWithText("Check now")!.disabled).toBe(true);
  });

  it("lets any client apply a staged update now", async () => {
    seed({ status: "staged", latestVersion: "1.1.0", stagedVersion: "1.1.0" });
    renderCard();
    expect(document.body.textContent).toContain("1.1.0 downloaded and verified");
    await click(buttonWithText("Apply now")!);
    expect(backendMock.applyHostUpdate).toHaveBeenCalledOnce();
    expect(buttonWithText("Defer")).toBeNull();
  });

  it("counts down with the affected sessions and lets a client defer until the limit", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      seed({
        status: "countdown",
        latestVersion: "1.1.0",
        stagedVersion: "1.1.0",
        graceDeadlineMs: 1_000_000 + 90_000,
        deferrals: 1,
        deferralLimit: 3,
        affectedTabIds: ["a", "b"],
      });
      renderCard();
      expect(document.body.textContent).toContain("1.1.0 applies in 1:30");
      expect(document.body.textContent).toContain("2 live session(s) will be interrupted");
      expect(document.body.textContent).toContain("deferred 1 of 3");
      await click(buttonWithText("Defer")!);
      expect(backendMock.deferHostUpdate).toHaveBeenCalledOnce();
      await click(buttonWithText("Apply now")!);
      expect(backendMock.applyHostUpdate).toHaveBeenCalledOnce();

      // The deadline reads live: a second later, one second less.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(document.body.textContent).toContain("1.1.0 applies in 1:29");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables Defer once the host's deferral limit is spent", () => {
    seed({
      status: "countdown",
      stagedVersion: "1.1.0",
      graceDeadlineMs: Date.now() + 60_000,
      deferrals: 3,
      deferralLimit: 3,
    });
    renderCard();
    expect(buttonWithText("Defer")!.disabled).toBe(true);
    expect(buttonWithText("Apply now")!.disabled).toBe(false);
  });

  it("offers a rollback only while one is retained and nothing is in flight", async () => {
    seed({ rollbackVersion: "0.9.0", lastAttempt: { fromVersion: "0.9.0", toVersion: "1.0.0", outcome: "applied", atMs: 1 } });
    renderCard();
    expect(document.body.textContent).toContain("last update: 0.9.0 → 1.0.0");
    await click(buttonWithText("Roll back to 0.9.0")!);
    expect(backendMock.rollbackHostUpdate).toHaveBeenCalledOnce();

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    seed({ status: "applying", stagedVersion: "1.1.0", rollbackVersion: "0.9.0" });
    renderCard();
    expect(buttonWithText("Roll back to 0.9.0")).toBeNull();
    expect(document.body.textContent).toContain("applying 1.1.0");
  });

  it("surfaces the host's error and reports a rejected action as a notice", async () => {
    seed({ status: "error", error: "sha512 mismatch" });
    useStore.setState({ errorNotices: [] });
    backendMock.checkHostUpdate.mockRejectedValueOnce(new Error("host unreachable"));
    renderCard();
    expect(document.body.textContent).toContain("host update failed");
    expect(document.body.textContent).toContain("sha512 mismatch");
    await click(buttonWithText("Check now")!);
    expect(useStore.getState().errorNotices.map((n) => n.message)).toContain("host unreachable");
  });
});
