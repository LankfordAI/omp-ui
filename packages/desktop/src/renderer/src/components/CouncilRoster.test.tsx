// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CouncilRosterView, CouncilWriteRequest, ModelCatalogSnapshot } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

const hawk = { name: "hawk", model: "anthropic/sonnet", instructions: null, enabled: true };
// A realistic view: effective members only ever exist when some scope's
// document exists — the editor's override seed reads that stored document.
const roster = (over: Partial<CouncilRosterView> = {}): CouncilRosterView => ({
  members: [hawk],
  instructions: null,
  configWarnings: [],
  global: { instructions: null, members: [hawk] },
  project: null,
  effective: [{ ...hawk, sourceScope: "user" }],
  ...over,
});

const backendMock = {
  getCouncilRoster: vi.fn(async () => roster()),
  setCouncilRoster: vi.fn(async () => roster({ project: { instructions: null, members: [hawk] } })),
  restartSession: vi.fn(async () => true),
};
Object.assign(window, { ompBackend: backendMock });

// Dynamic imports: the backend mock must exist on the window before these
// modules load; static imports would hoist above the assignment.
const { useStore } = await import("../store");
const { CouncilRosterEditor } = await import("./CouncilRoster");

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
const inputs = (label: string) => document.body.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`);
const typeInto = async (el: HTMLElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const lastWrite = (): CouncilWriteRequest =>
  (backendMock.setCouncilRoster.mock.calls[0] as unknown as [CouncilWriteRequest])[0];

describe("CouncilRosterEditor", () => {
  it("saves a project edit as the whole document", async () => {
    useStore.setState({ state: null });
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    expect(inputs("Member").length).toBe(2);
    await typeInto(inputs("Member")[1]!, "fresh");
    await typeInto(inputs("Model")[1]!, "openai/gpt-5");
    await act(async () => btn("Save").click());
    expect(backendMock.setCouncilRoster).toHaveBeenCalledTimes(1);
    const req = lastWrite();
    expect(req).toMatchObject({ scope: "project", scopeCwd: "/p" });
    expect(req.document!.members.map((m) => [m.name, m.model])).toEqual([
      ["hawk", "anthropic/sonnet"],
      ["fresh", "openai/gpt-5"],
    ]);
    expect(document.body.textContent).toContain("until restarted");
  });

  it("sends null when the project draft equals the global document", async () => {
    backendMock.getCouncilRoster.mockResolvedValueOnce(
      roster({ global: { instructions: null, members: [hawk] } }),
    );
    useStore.setState({ state: null });
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    // Project scope seeds from the global document; editing it back to an
    // identical document clears the override rather than duplicating it.
    const enabled = document.body.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enabled"]')!;
    await act(async () => enabled.click());
    await act(async () => enabled.click());
    await act(async () => btn("Save").click());
    const req = lastWrite();
    expect(req.scope).toBe("project");
    expect(req.document).toBe(null);
  });

  it("clears the override directly when the project document exists", async () => {
    backendMock.getCouncilRoster.mockResolvedValueOnce(
      roster({ global: { instructions: null, members: [] }, project: { instructions: null, members: [hawk] } }),
    );
    useStore.setState({ state: null });
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Clear override").click());
    expect(lastWrite()).toEqual({ scopeCwd: "/p", scope: "project", document: null });
  });

  it("keeps the draft and shows the error when a save is rejected", async () => {
    backendMock.setCouncilRoster.mockRejectedValueOnce(new Error("registry write failed"));
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Member")[1]!, "x");
    await typeInto(inputs("Model")[1]!, "openai/gpt-5");
    await act(async () => btn("Save").click());
    expect(document.body.textContent).toContain("registry write failed");
    expect(inputs("Member").length).toBe(2);
  });

  it("keeps Save disabled while a member lacks a model", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Member")[1]!, "fresh");
    expect(btn("Save").disabled).toBe(true);
    expect(document.body.textContent).toContain("Pick a model for every member.");
    await typeInto(inputs("Model")[1]!, "openai/gpt-5");
    expect(btn("Save").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Pick a model for every member.");
  });

  it("persists a blank name so the member keeps following its model (#1057)", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Model")[1]!, "openrouter/anthropic/claude-opus-5.5");
    // A blank name with a launchable model is valid; the placeholder previews
    // the derived name, but Save stores it blank so the name re-derives when
    // the model changes.
    expect(btn("Save").disabled).toBe(false);
    expect(inputs("Member")[1]!.placeholder).toBe("claude-opus-5-5");
    await act(async () => btn("Save").click());
    expect(lastWrite().document!.members[1]!.name).toBe("");
  });

  it("allows Save when two blank names derive the same slug (#1057)", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Model")[1]!, "openrouter/anthropic/gpt-4x");
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Model")[2]!, "azure/gpt-4x");
    // Derived collisions are the validator's job (it suffixes -2), not a block.
    expect(btn("Save").disabled).toBe(false);
  });

  it("blocks Save when two explicit names collide", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    await typeInto(inputs("Member")[1]!, "hawk");
    await typeInto(inputs("Model")[1]!, "openai/gpt-5");
    expect(btn("Save").disabled).toBe(true);
  });

  it("disables Add member once the council has three members", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Add member").click());
    expect(btn("Add member").disabled).toBe(false);
    await act(async () => btn("Add member").click());
    expect(inputs("Member").length).toBe(3);
    expect(btn("Add member").disabled).toBe(true);
    expect(btn("Add member").title).toBe("A council has at most three members.");
  });

  it("reads omp's chat catalog once for a local project and picks from it", async () => {
    const catalog: ModelCatalogSnapshot = {
      models: [
        { provider: "litellm", id: "quick", name: "Quick" },
        { provider: "anthropic", id: "sonnet", name: "Sonnet" },
      ],
      discovered: true,
      error: null,
    };
    const readChatModels = vi.fn<() => Promise<ModelCatalogSnapshot>>(async () => catalog);
    useStore.setState({ state: null, readChatModels });
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    await act(async () => btn("Pick…").click());
    expect(readChatModels).toHaveBeenCalledTimes(1);
    // The palette opens on Favorites; the provider tab lists the catalog rows.
    const litellm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("litellm"),
    )!;
    await act(async () => litellm.click());
    const quick = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Quick"),
    )!;
    await act(async () => quick.click());
    expect(inputs("Model")[0]!.value).toBe("litellm/quick");
    await act(async () => btn("Pick…").click());
    expect(readChatModels).toHaveBeenCalledTimes(1);
  });

  it("shows the resolution warnings and renders no scope buttons without a cwd", async () => {
    backendMock.getCouncilRoster.mockResolvedValueOnce(
      roster({
        configWarnings: ["duplicate slug"],
        effective: [
          { ...hawk, sourceScope: "user" },
          { name: "owl", model: null, instructions: null, enabled: true, sourceScope: "user" },
        ],
      }),
    );
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("duplicate slug");
    expect(document.body.textContent).toContain("hawk · on · anthropic/sonnet · Global");
    expect(document.body.textContent).toContain("owl · on · no model — skipped · Global");
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
    // Without a cwd there is no project scope to offer: the toggle row is
    // gone entirely (no disabled Project button), and the editor still loads
    // and edits the global document.
    await mount(<CouncilRosterEditor scopeCwd={null} instanceId={null} />);
    const scopeButtons = [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
      (b) => b.textContent?.trim() === "Project" || b.textContent?.trim() === "Global",
    );
    expect(scopeButtons).toHaveLength(0);
    expect(document.body.textContent).toContain("/council asks each enabled member");
    expect(document.querySelector('[data-testid="council-roster-editor"]')).not.toBeNull();
    expect(document.body.textContent).toContain("hawk · on · anthropic/sonnet · Global");
  });

  it("names the inherit chain when the project scope is unset", async () => {
    await mount(<CouncilRosterEditor scopeCwd="/p" instanceId={null} />);
    expect(document.body.textContent).toContain("the global council applies");
  });
});
