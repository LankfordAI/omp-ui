// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewDocument, ReviewRosterView, ReviewWriteRequest } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

const hawk = { name: "hawk", model: null, instructions: null, targets: null, enabled: true };
const empty = (): ReviewDocument => ({ instructions: null, reviewers: [] });
const roster = (over: Partial<ReviewRosterView> = {}): ReviewRosterView => ({
  reviewers: [hawk],
  instructions: null,
  configWarnings: [],
  global: null,
  project: null,
  effective: [{ ...hawk, sourceScope: "user" }],
  ...over,
});

const backendMock = {
  getReviewRoster: vi.fn(async () => roster()),
  setReviewRoster: vi.fn(async () => roster({ project: { instructions: null, reviewers: [hawk] } })),
  restartSession: vi.fn(async () => true),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { ReviewRosterEditor } = await import("./ReviewRoster");

// Dynamic imports: the backend mock must exist on the window before these
// modules load; static imports would hoist above the assignment.
let root: Root | null = null;
async function mount(node: React.ReactNode): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await act(async () => {});
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
const btn = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const typeInto = async (el: HTMLElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("ReviewRosterEditor", () => {
  it("saves a project edit as the whole document", async () => {
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add reviewer").click());
    const names = document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Reviewer"]');
    expect(names.length).toBe(2);
    await typeInto(names[1]!, "fresh");
    await act(async () => btn("Save").click());
    expect(backendMock.setReviewRoster).toHaveBeenCalledTimes(1);
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req).toMatchObject({ scope: "project", scopeCwd: "/p" });
    expect(req.document!.reviewers.map((r) => r.name)).toEqual(["hawk", "fresh"]);
    expect(document.body.textContent).toContain("until restarted");
  });

  it("sends null when the project draft equals the global document", async () => {
    backendMock.getReviewRoster.mockResolvedValueOnce(
      roster({ global: { instructions: null, reviewers: [hawk] } }),
    );
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    // Project scope seeds from the global document; editing it back to an
    // identical document clears the override rather than duplicating it.
    await act(async () => btn("All targets").click());
    await act(async () => btn("All targets").click());
    await act(async () => btn("Save").click());
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req.scope).toBe("project");
    expect(req.document).toBe(null);
  });

  it("clears the override directly when the project document exists", async () => {
    backendMock.getReviewRoster.mockResolvedValueOnce(
      roster({ global: { instructions: null, reviewers: [] }, project: { instructions: null, reviewers: [hawk] } }),
    );
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Clear override").click());
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req).toEqual({ scopeCwd: "/p", scope: "project", document: null });
  });

  it("keeps the draft and shows the error when a save is rejected", async () => {
    backendMock.setReviewRoster.mockRejectedValueOnce(new Error("registry write failed"));
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add reviewer").click());
    await typeInto(document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Reviewer"]')[1]!, "x");
    await act(async () => btn("Save").click());
    expect(document.body.textContent).toContain("registry write failed");
    expect(document.body.querySelectorAll('input[aria-label="Reviewer"]').length).toBe(2);
  });

  it("toggles target kinds and writes the selection through", async () => {
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("All targets").click());
    await act(async () => btn("pr").click());
    await act(async () => btn("Save").click());
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req.document!.reviewers[0]!.targets).toEqual(["local", "commit"]);
  });

  it("shows the resolution warnings and never targets project without a cwd", async () => {
    backendMock.getReviewRoster.mockResolvedValueOnce(roster({ configWarnings: ["duplicate slug"] }));
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("duplicate slug");
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await mount(<ReviewRosterEditor scopeCwd={null} instanceId={null} />);
    expect(btn("Project").disabled).toBe(true);
  });

  it("names the inherit chain when the project scope is unset", async () => {
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("the global roster applies");
  });
});
