// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { WatchdogDocument, WatchdogFileView, WatchdogRosterResult } from "@omp-ui/core/types";
import { rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

const empty = (): WatchdogDocument => ({ instructions: null, maxNotesPerUpdate: null, advisors: [] });
const fileView = (scope: "user" | "project", over: Partial<WatchdogFileView> = {}): WatchdogFileView => ({
  scope, path: `/${scope}/WATCHDOG.yml`, exists: true, hash: "h1", document: empty(), blocking: [], notices: [], ...over,
});
const roster = (project: Partial<WatchdogFileView> = {}): WatchdogRosterResult => ({
  status: "available",
  user: fileView("user"),
  project: fileView("project", project),
  effective: [
    { name: "writer", slug: "writer", sourcePath: "/p", sourceScope: "project", model: null, tools: ["read", "write"], toolsExplicit: true, enabled: true, instructions: null, maxNotesPerUpdate: null },
  ],
  sharedInstructions: [],
  otherFiles: [],
  warnings: [],
});

const backendMock = {
  getWatchdogRoster: vi.fn(async () => roster({ document: { ...empty(), advisors: [{ name: "writer", model: null, tools: ["read", "write"], instructions: null, enabled: null, maxNotesPerUpdate: null }] } })),
  setWatchdogRoster: vi.fn(async () => roster()),
  restartSession: vi.fn(async () => true),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { AdvisorRosterView, AdvisorRosterEditor } = await import("./AdvisorRoster");

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

const stats = (over: Partial<AdvisorStatsView> = {}): AdvisorStatsView => ({
  available: true, configured: true, active: true, model: "x/y", subscription: false,
  contextWindow: 1000, contextTokens: 500, cost: 0.5, totalTokens: 100, advisors: [], configWarnings: [], ...over,
});
const member = (name: string, status: "running" | "paused" | "no_model", model: string | null = null) => ({
  name, status, model, contextWindow: 1000, contextTokens: 100, cost: 0.1, totalTokens: 10, yielded: null,
});

describe("AdvisorRosterView", () => {
  it("renders one row per member with status, tools and the file-change mark", async () => {
    useStore.setState({ rpc: { t: rpcTabState({ advisorStats: stats({ advisors: [member("writer", "running", "p/m"), member("ghost", "no_model")] }) }) } });
    await mount(<AdvisorRosterView tabId="t" instanceId={null} cwd="/p" />);
    const text = document.body.textContent!;
    expect(text).toContain("writer");
    expect(text).toContain("running");
    expect(text).toContain("no model");
    expect(text).toContain("p/m");
    expect(text).toContain("can change files");
    expect(text).toContain("read, write");
  });

  it("shows the off ceiling, config warnings and the older-omp fallback", async () => {
    useStore.setState({ rpc: { t: rpcTabState({ advisorStats: stats({ configured: false, configWarnings: ["bad file"] }) }) } });
    await mount(<AdvisorRosterView tabId="t" instanceId={null} cwd="/p" />);
    expect(document.body.textContent).toContain("every entry is inactive");
    expect(document.body.textContent).toContain("bad file");
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    useStore.setState({ rpc: { t: rpcTabState({ advisorStats: stats() }) } });
    await mount(<AdvisorRosterView tabId="t" instanceId={null} cwd="/p" />);
    expect(document.body.textContent).toContain("older omp");
  });
});

describe("AdvisorRosterEditor", () => {
  it("saves a project edit with the loaded hash and offers restart for live sessions", async () => {
    useStore.setState({ state: null });
    await mount(<AdvisorRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add advisor").click());
    const name = document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Advisor"]');
    expect(name.length).toBe(2);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name[1], "fresh");
      name[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => btn("Save").click());
    expect(backendMock.setWatchdogRoster).toHaveBeenCalledTimes(1);
    const req = (backendMock.setWatchdogRoster.mock.calls[0] as unknown as [{ scope: string; scopeCwd: string; baseHash: string; document: WatchdogDocument }])[0];
    expect(req).toMatchObject({ scope: "project", scopeCwd: "/p", baseHash: "h1" });
    expect(req.document.advisors.map((a) => a.name)).toEqual(["writer", "fresh"]);
    expect(document.body.textContent).toContain("until restarted");
  });

  it("keeps the draft and shows the error when a save is rejected", async () => {
    backendMock.setWatchdogRoster.mockRejectedValueOnce(new Error("changed on disk"));
    await mount(<AdvisorRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add advisor").click());
    await act(async () => {
      const el = document.body.querySelectorAll<HTMLInputElement>('input[aria-label="Advisor"]')[1]!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "x");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => btn("Save").click());
    expect(document.body.textContent).toContain("changed on disk");
    expect(document.body.querySelectorAll('input[aria-label="Advisor"]').length).toBe(2);
  });

  it("disables Save and editing when the file has blocking problems, and never targets project without a cwd", async () => {
    backendMock.getWatchdogRoster.mockResolvedValueOnce(roster({ blocking: ["/p: unknown key"] }));
    await mount(<AdvisorRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("unknown key");
    expect(btn("Save").disabled).toBe(true);
    expect(btn("Add advisor").disabled).toBe(true);
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    await mount(<AdvisorRosterEditor scopeCwd={null} instanceId={null} />);
    expect(btn("Project").disabled).toBe(true);
  });
});
