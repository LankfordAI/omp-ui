// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirBrowseResult, VaultDetection, VaultRegistry } from "@omp-ui/core/types";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, hence no scrollIntoView; the directory picker calls it on the active row.
HTMLElement.prototype.scrollIntoView = vi.fn();

const NO_DETECTION: VaultDetection = {
  obsidianListFile: null,
  obsidianList: [],
  cliRegistered: false,
  uriHandler: false,
  rows: {},
};

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  browseDirectories: vi.fn<(query: string) => Promise<DirBrowseResult>>(),
  detectVaults: vi.fn<() => Promise<VaultDetection>>(async () => NO_DETECTION),
  addVault: vi.fn<(path: string) => Promise<void>>(async () => {}),
  importVaults: vi.fn<(ids: string[]) => Promise<{ added: string[]; skipped: string[] }>>(async () => ({
    added: [],
    skipped: [],
  })),
  removeVault: vi.fn(async () => {}),
  setDefaultWriteVault: vi.fn(async () => {}),
  setVaultHomeFolder: vi.fn<(name: string, homeFolder: string) => Promise<void>>(async () => {}),
  setVaultWritesOutsideHome: vi.fn(async () => {}),
  openVault: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../../store");
const { KnowledgeVaultPage } = await import("./KnowledgeVaultPage");

const LIST_FILE = "/home/u/.config/obsidian/obsidian.json";

const ONE_VAULT: VaultRegistry = {
  vaults: [{ name: "Vault", path: "/home/u/Vault", homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
  defaultWriteVault: "Vault",
};

function detection(patch: Partial<VaultDetection> = {}): VaultDetection {
  return {
    obsidianListFile: LIST_FILE,
    obsidianList: [{ id: "d54189eae5e5b8ef", path: "/home/u/Vault", open: true, registeredAs: "Vault" }],
    cliRegistered: true,
    uriHandler: true,
    rows: { Vault: { status: "ok", inObsidianList: true, obsidianId: "d54189eae5e5b8ef" } },
    ...patch,
  };
}

let root: Root | null = null;

async function render(registry: VaultRegistry): Promise<void> {
  useStore.setState({ state: backendState({ vaultRegistry: registry }) });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // The async act flushes the detectVaults read.
  await act(async () => root!.render(<KnowledgeVaultPage />));
}

function text(): string {
  return document.body.textContent ?? "";
}

function input(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`input not found: ${label}`);
  return found;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.detectVaults.mockResolvedValue(NO_DETECTION);
  backendMock.addVault.mockResolvedValue(undefined);
  backendMock.setVaultHomeFolder.mockResolvedValue(undefined);
  useStore.setState({ errorNotices: [] });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("KnowledgeVaultPage (issue #764)", () => {
  it("shows the empty state with both actions and disables Import without Obsidian's list", async () => {
    await render({ vaults: [], defaultWriteVault: null });
    expect(text()).toContain("No vault yet");
    expect(button("Add vault…").disabled).toBe(false);
    const importButton = button("Import from Obsidian…");
    expect(importButton.disabled).toBe(true);
    expect(importButton.title).toBe("Obsidian's vault list was not found on this machine.");
    expect(text()).toContain("not found");
    expect(text()).toContain("none");
  });

  it("renders a registered vault with its detection rows and the pin line", async () => {
    backendMock.detectVaults.mockResolvedValue(detection());
    await render(ONE_VAULT);

    expect(text()).toContain("Vault");
    expect(text()).toContain("/home/u/Vault");
    const radio = document.body.querySelector<HTMLInputElement>('input[type="radio"]');
    expect(radio?.checked).toBe(true);
    expect(input("Home folder").value).toBe("omp-ui/");
    expect(text()).toContain("in Obsidian's list");
    expect(text()).not.toContain("not in Obsidian's list");

    for (const label of ["Obsidian app", "Vault list", "Command line", "obsidian:// links"]) {
      expect(text()).toContain(label);
    }
    expect(text()).toContain(LIST_FILE);
    expect(text()).toContain("found");
    expect(text()).toContain("read");
    expect(text()).toContain("registered");
    expect(text()).toContain("Optional. omp-ui works without it.");
    expect(text()).toContain("handled");
    expect(text()).toContain("omp's own vault:// protocol stays off in omp-ui sessions");
    expect(button("Import from Obsidian…").disabled).toBe(false);
  });

  it("chips a row whose folder vanished as folder missing", async () => {
    backendMock.detectVaults.mockResolvedValue(
      detection({ rows: { Vault: { status: "missing", inObsidianList: false, obsidianId: null } } }),
    );
    await render(ONE_VAULT);
    expect(text()).toContain("folder missing");
    expect(text()).toContain("not in Obsidian's list");
  });

  it("shows a refused home folder inline and keeps the last valid value", async () => {
    backendMock.detectVaults.mockResolvedValue(detection());
    backendMock.setVaultHomeFolder.mockRejectedValue(
      new Error("Error invoking remote method 'vault:setHomeFolder': Error: Use a folder inside the vault, like omp-ui/."),
    );
    await render(ONE_VAULT);

    const field = input("Home folder");
    await act(async () => field.focus());
    await typeInto(field, "../x");
    await act(async () => field.blur());
    // The store re-throws after reporting; let the page's catch settle.
    await act(async () => {});

    expect(backendMock.setVaultHomeFolder).toHaveBeenCalledWith("Vault", "../x");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "Use a folder inside the vault, like omp-ui/.",
    );
    expect(input("Home folder").value).toBe("omp-ui/");
    // Inline only: no global "Action failed" modal stacked over the Settings page.
    expect(useStore.getState().errorNotices).toEqual([]);
  });

  it("imports only unregistered entries; registered ones stay checked, disabled and chipped added", async () => {
    backendMock.detectVaults.mockResolvedValue(
      detection({
        obsidianList: [
          { id: "d54189eae5e5b8ef", path: "/home/u/Vault", open: true, registeredAs: "Vault" },
          { id: "ee8bdab8baa42089", path: "/home/u/Notes", open: false, registeredAs: null },
        ],
      }),
    );
    await render(ONE_VAULT);
    await act(async () => button("Import from Obsidian…").click());

    const dialog = document.body.querySelector<HTMLElement>('[aria-labelledby="vault-import-title"]');
    expect(dialog?.textContent).toContain("Import from Obsidian");
    expect(dialog?.textContent).toContain("added");
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].disabled).toBe(true);
    expect(boxes[1].checked).toBe(false);
    expect(button("Import").disabled).toBe(true);

    await act(async () => boxes[1].click());
    expect(button("Import").disabled).toBe(false);
    await act(async () => button("Import").click());
    await act(async () => {});

    expect(backendMock.importVaults).toHaveBeenCalledWith(["ee8bdab8baa42089"]);
    expect(document.body.querySelector('[aria-labelledby="vault-import-title"]')).toBeNull();
  });

  it("adds a vault through the vault-mode picker and keeps it open on a refusal", async () => {
    const listings: Record<string, DirBrowseResult> = {
      "~/": { parentPath: "/home/u", entries: [{ name: "Vault", fullPath: "/home/u/Vault" }], error: null },
      "/home/u/.obsidian": { parentPath: "/home/u", entries: [], error: null },
      "/home/u/Vault/": { parentPath: "/home/u/Vault", entries: [], error: null },
      "/home/u/Vault/.obsidian": {
        parentPath: "/home/u/Vault",
        entries: [{ name: ".obsidian", fullPath: "/home/u/Vault/.obsidian" }],
        error: null,
      },
    };
    backendMock.browseDirectories.mockImplementation(
      async (query) => listings[query] ?? { parentPath: "", entries: [], error: "invalid" },
    );
    await render({ vaults: [], defaultWriteVault: null });
    await act(async () => button("Add vault…").click());

    const path = input("vault folder path");
    expect(path.placeholder).toBe("~/path/to/vault");
    expect(text()).toContain("Will add:");
    expect(text()).toContain("not a vault yet");

    await typeInto(path, "/home/u/Vault/");
    expect(backendMock.browseDirectories).toHaveBeenCalledWith("/home/u/Vault/.obsidian");
    expect(text()).toContain(".obsidian/ found");

    backendMock.addVault.mockRejectedValueOnce(
      new Error("Error invoking remote method 'vault:add': Error: A vault named Vault is already registered."),
    );
    await act(async () => button("Add vault").click());
    expect(backendMock.addVault).toHaveBeenCalledWith("/home/u/Vault");
    expect(text()).toContain("A vault named Vault is already registered.");
    expect(input("vault folder path")).toBeTruthy();
    expect(useStore.getState().errorNotices).toEqual([]);

    await act(async () => button("Add vault").click());
    expect(backendMock.addVault).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector('input[aria-label="vault folder path"]')).toBeNull();
  });
});
