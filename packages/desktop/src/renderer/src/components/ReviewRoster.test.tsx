// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewDocument, ReviewFileView, ReviewRosterView, ReviewWriteRequest } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

const empty = (): ReviewDocument => ({ instructions: null, reviewers: [] });
const fileView = (scope: "user" | "project", over: Partial<ReviewFileView> = {}): ReviewFileView => ({
  scope, path: `/${scope}/REVIEW.yml`, exists: true, hash: "h1", document: empty(), blocking: [], ...over,
});
const roster = (project: Partial<ReviewFileView> = {}): ReviewRosterView => ({
  reviewers: [{ name: "hawk", model: null, instructions: null, targets: null, enabled: true }],
  instructions: null,
  configWarnings: [],
  user: fileView("user"),
  project: fileView("project", project),
  effective: [
    { name: "hawk", model: null, instructions: null, targets: null, enabled: true, sourcePath: "/p/REVIEW.yml", sourceScope: "project" },
  ],
});

const backendMock = {
  getReviewRoster: vi.fn(async () => roster({ document: { ...empty(), reviewers: [{ name: "hawk", model: null, instructions: null, targets: null, enabled: true }] } })),
  setReviewRoster: vi.fn(async () => roster()),
  restartSession: vi.fn(async () => true),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { ReviewRosterEditor } = await import("./ReviewRoster");

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

describe("ReviewRosterEditor", () => {
  it("saves a project edit with the loaded hash", async () => {
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add reviewer").click());
    const names = document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Reviewer"]');
    expect(names.length).toBe(2);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(names[1], "fresh");
      names[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => btn("Save").click());
    expect(backendMock.setReviewRoster).toHaveBeenCalledTimes(1);
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req).toMatchObject({ scope: "project", scopeCwd: "/p", baseHash: "h1" });
    expect(req.document.reviewers.map((r) => r.name)).toEqual(["hawk", "fresh"]);
    expect(document.body.textContent).toContain("until restarted");
  });

  it("keeps the draft and shows the error when a save is rejected", async () => {
    backendMock.setReviewRoster.mockRejectedValueOnce(new Error("changed on disk"));
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add reviewer").click());
    await act(async () => {
      const el = document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Reviewer"]')[1]!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "x");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => btn("Save").click());
    expect(document.body.textContent).toContain("changed on disk");
    expect(document.body.querySelectorAll('input[aria-label="Reviewer"]').length).toBe(2);
  });

  it("toggles target kinds and writes the selection through", async () => {
    useStore.setState({ state: null });
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("All targets").click());
    expect(btn("All targets").getAttribute("aria-pressed")).toBe("false");
    await act(async () => btn("pr").click());
    await act(async () => btn("Save").click());
    const req = (backendMock.setReviewRoster.mock.calls[0] as unknown as [ReviewWriteRequest])[0];
    expect(req.document.reviewers[0]!.targets).toEqual(["local", "commit"]);
  });

  it("disables Save and editing when the file has blocking problems, and never targets project without a cwd", async () => {
    backendMock.getReviewRoster.mockResolvedValueOnce(roster({ blocking: ["/p: unknown key"] }));
    await mount(<ReviewRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("unknown key");
    expect(btn("Save").disabled).toBe(true);
    expect(btn("Add reviewer").disabled).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await mount(<ReviewRosterEditor scopeCwd={null} instanceId={null} />);
    expect(btn("Project").disabled).toBe(true);
  });
});
