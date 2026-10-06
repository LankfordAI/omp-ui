// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { obsidianOpenUri } from "@omp-ui/core/vault-shared";
import { t } from "../lib/i18n";
import { parseOmpDiff } from "../lib/omp-diff";
import type { ToolItem } from "../lib/transcript";
import { backendState, remoteOwnedState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ electron: false }));

vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

// The edit card's diff renders open; keep Shiki out of jsdom.
vi.mock(import("../lib/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useHighlightTokens: () => null };
});

Object.assign(window, { ompBackend: {} });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { VaultToolCard } = await import("./VaultToolCard");

const realOpenVault = useStore.getState().openVault;
const openVault = vi.fn<(name: string, file: string | null) => Promise<void>>(async () => {});
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});

const TAB = "vault-card-remote-tab";
const INSTANCE = "inst-remote";
const PATH = "omp-ui/proj/Card Lesson.md";
const STAMP = ["created: 2026-10-06", "project: proj", "source: omp-ui"];

let root: Root | null = null;

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "call-1",
    name: "omp-ui_vault_create",
    args: {},
    status: "done",
    ...overrides,
  };
}

const created = tool({
  name: "omp-ui_vault_create",
  vault: {
    vaultName: "Notes",
    vaultId: null,
    path: PATH,
    action: "create",
    createdByOmpUi: true,
    title: "Card Lesson",
    stamp: STAMP,
    preview: "Cards settle like any other tool.",
  },
});

function render(item: ToolItem, tabId?: string): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<VaultToolCard item={item} tabId={tabId} />));
  return host;
}

function openButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === t("transcript.vault.openInObsidian"));
}

beforeEach(() => {
  mocks.electron = false;
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useStore.setState({ state: backendState(), openVault });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useStore.setState({ openVault: realOpenVault });
});

describe("VaultToolCard", () => {
  it("a create shows the Created chip, path line, stamp, preview and the open button", () => {
    const host = render(created);
    const text = host.textContent ?? "";

    expect(text).toContain("Card Lesson");
    expect(text).toContain(t("transcript.vault.created"));
    expect(text).toContain(`Notes · ${PATH}`);
    expect(text).toContain(STAMP.join(" · "));
    expect(text).toContain("Cards settle like any other tool.");
    expect(text).not.toContain(t("transcript.vault.notCreated"));
    expect(text).toContain(t("transcript.vault.openInObsidian"));
    expect(openButton(host)).toBeDefined();
  });

  it("an append into a note omp-ui did not create carries the Not created chip", () => {
    const host = render(
      tool({
        name: "omp-ui_vault_append",
        vault: {
          vaultName: "Notes",
          vaultId: null,
          path: "Inbox/Hand Written.md",
          action: "append",
          createdByOmpUi: false,
          preview: "An appended paragraph.",
        },
      }),
    );
    const text = host.textContent ?? "";

    expect(text).toContain(t("transcript.vault.appended"));
    expect(text).toContain("An appended paragraph.");
    expect(text).toContain("Notes · Inbox/Hand Written.md");
    expect(text).toContain(t("transcript.vault.notCreated"));
  });

  it("an edit of a stamped note renders the diff open without the Not created chip", () => {
    const diff = " 1|# Card Lesson\n-2|old\n+2|new";
    const host = render(
      tool({
        name: "omp-ui_vault_edit",
        diff: parseOmpDiff(diff),
        vault: {
          vaultName: "Notes",
          vaultId: null,
          path: PATH,
          action: "edit",
          createdByOmpUi: true,
          diff,
        },
      }),
    );
    const text = host.textContent ?? "";

    expect(text).toContain(t("transcript.vault.edited"));
    expect(text).toContain(`Notes · ${PATH}`);
    expect(text).not.toContain(t("transcript.vault.notCreated"));
    const leaves = [...host.querySelectorAll("*")].filter((el) => el.children.length === 0);
    expect(leaves.some((el) => el.textContent === "new")).toBe(true);
  });

  it("a running write shows the args title and the running chip, without an open button", () => {
    const host = render(tool({ status: "running", args: { title: "Pending Note" } }));
    const text = host.textContent ?? "";

    expect(text).toContain("Pending Note");
    expect(text).toContain(t("transcript.tool.running"));
    expect(text).not.toContain(t("transcript.vault.openInObsidian"));
    expect(openButton(host)).toBeUndefined();
  });

  it("copies the link for a tab owned by a joined remote instance", async () => {
    mocks.electron = true;
    useStore.setState({ state: remoteOwnedState(TAB, INSTANCE) });
    const host = render(created, TAB);
    const button = openButton(host)!;
    expect(button.title).toBe(t("transcript.vault.copyTitle"));

    await act(async () => button.click());

    const uri = "obsidian://open?vault=Notes&file=omp-ui%2Fproj%2FCard%20Lesson";
    expect(obsidianOpenUri({ vault: "Notes" }, PATH)).toBe(uri);
    expect(writeText).toHaveBeenCalledWith(uri);
    expect(openVault).not.toHaveBeenCalled();
  });
});
