// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { act, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, OmpBackend, VaultRegistry } from "@omp-ui/core/types";
import type * as RendererBackend from "../backend";
import { obsidianReplyLink } from "@omp-ui/core/vault-shared";
import { openVaultTarget } from "../../../main/vault-open";
import { t } from "../lib/i18n";
import { backendState, remoteOwnedState } from "../test/fixtures";

type RootGuard = Parameters<typeof openVaultTarget>[3]["guard"];

// Main's real core imports include node:sqlite. Run them in the Node Vite
// environment, then supply a DOM for the renderer without replacing core logic.
const dom: { window: Window & typeof globalThis } = new (createRequire(import.meta.url)("jsdom").JSDOM)("", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "KeyboardEvent", "MouseEvent", "Event", "HTMLTextAreaElement", "localStorage"] as const) {
  vi.stubGlobal(key, dom.window[key]);
}
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const platform = vi.hoisted(() => ({ electron: true, webTransport: false }));
vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() { return platform.electron; },
  IS_MAC: false,
  IS_WINDOWS: false,
}));
vi.mock("../backend", async (importOriginal) => {
  const actual = await importOriginal<typeof RendererBackend>();
  return {
    ...actual,
    get desktopPaneMedia() { return platform.webTransport ? null : actual.desktopPaneMedia; },
  };
});

const TAB = "vault-local-tab";
const REMOTE_TAB = "vault-remote-tab";
const REMOTE = "vault-remote-instance";
const FILE = "nested/Foo (draft).md";
const PORTABLE_URI = "obsidian://open?vault=Notes&file=nested%2FFoo%20(draft)";
const MAIN_URI = "obsidian://open?vault=obsidian-vault-id&file=nested%2FFoo%20(draft)";

let vaultBase: string;
let guardBase: string;
let vaultReal: string;
let guard: RootGuard;
let registry: VaultRegistry;
let operations: Promise<void>[] = [];
const launch = vi.fn<(uri: string) => Promise<void>>(async () => {});
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
const execCommand = vi.fn<(command: string) => boolean>(() => false);

// Install the real activation bridge before backend.ts captures it. Only the
// final OS launch is substituted; the store and main path checks run normally.
const bridge = {
  openVault(name: string, file: string | null): Promise<void> {
    const operation = openVaultTarget(registry, name, file, {
      guard,
      obsidianList: async () => [{ id: "obsidian-vault-id", path: vaultReal, open: false }],
      open: launch,
    });
    operations.push(operation);
    return operation;
  },
  setWindowChrome: vi.fn(async () => {}),
} satisfies Pick<OmpBackend, "openVault" | "setWindowChrome">;
Object.assign(window, { ompBackend: bridge });
const { useStore } = await import("../store");
const { Markdown } = await import("./Markdown");
const { MarkdownVaultProvider } = await import("./MarkdownVaultProvider");
const { OpenInObsidianLink } = await import("./OpenInObsidianButton");

let root: Root | null = null;
let host: HTMLDivElement;

function localState(): BackendState {
  const remote = remoteOwnedState(TAB, REMOTE);
  return backendState({ projects: remote.remoteInstances[0]!.projects, vaultRegistry: registry });
}

function mount(children: ReactNode): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(children));
}

function render({
  tabId = TAB,
  file = FILE,
  vault = "Notes",
  portal = false,
  onCardClick,
}: {
  tabId?: string;
  file?: string;
  vault?: string;
  portal?: boolean;
  onCardClick?: () => void;
} = {}): HTMLAnchorElement {
  const markdown = <Markdown text={obsidianReplyLink(vault, file, "Exact note")} />;
  let content: ReactNode = markdown;
  if (portal) {
    const target = document.createElement("div");
    target.dataset.portal = "true";
    document.body.append(target);
    content = createPortal(markdown, target);
  }
  mount(
    <MarkdownVaultProvider tabId={tabId}>
      <div onClick={onCardClick}>{content}</div>
    </MarkdownVaultProvider>,
  );
  return document.body.querySelector('a[role="link"]')!;
}

async function activate(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.allSettled(operations.splice(0));
  });
}

beforeEach(() => {
  platform.electron = true;
  platform.webTransport = false;
  operations = [];
  launch.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  execCommand.mockReset().mockReturnValue(false);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  vaultBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-link-"));
  guardBase = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-link-guard-"));
  guard = {
    home: path.join(guardBase, "home"),
    userData: path.join(guardBase, "userData"),
    agentDir: path.join(guardBase, "agent"),
    sessionsRoot: path.join(guardBase, "sessions"),
    archiveRoot: path.join(guardBase, "archive"),
  };
  for (const dir of Object.values(guard)) fs.mkdirSync(dir, { recursive: true });
  const vault = path.join(vaultBase, "Notes");
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vault, "nested"), { recursive: true });
  fs.mkdirSync(path.join(vault, "other"), { recursive: true });
  fs.writeFileSync(path.join(vault, FILE), "# Exact note\nNested target\n");
  fs.writeFileSync(path.join(vault, "other", "Foo (draft).md"), "# Exact note\nDifferent target\n");
  fs.writeFileSync(path.join(vault, ".obsidian", "Hidden.md"), "Hidden\n");
  vaultReal = fs.realpathSync.native(vault);
  registry = {
    vaults: [{ name: "Notes", path: vaultReal, homeFolder: "nested/", allowWritesOutsideHome: false }],
    defaultWriteVault: "Notes",
  };
  useStore.setState({ state: localState(), errorNotices: [] });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  useStore.setState({ state: null, errorNotices: [] });
  fs.rmSync(vaultBase, { recursive: true, force: true });
  fs.rmSync(guardBase, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("scoped Markdown vault activation", () => {
  it.each(["click", "Enter", " "])("opens the exact nested duplicate-title note with %s", async (gesture) => {
    const cardClick = vi.fn();
    const link = render({ onCardClick: cardClick });
    expect(link.textContent).toBe("Exact note");
    expect(link.title).toBe(t("transcript.vault.openInObsidian"));
    expect(link.tabIndex).toBe(0);
    expect(link.hasAttribute("href")).toBe(false);
    link.focus();
    const key = new KeyboardEvent("keydown", { key: gesture, bubbles: true, cancelable: true });
    await activate(() => gesture === "click" ? link.click() : link.dispatchEvent(key));
    expect(launch).toHaveBeenCalledExactlyOnceWith(MAIN_URI);
    expect(writeText).not.toHaveBeenCalled();
    expect(cardClick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(link);
    if (gesture !== "click") expect(key.defaultPrevented).toBe(true);
    expect(useStore.getState().errorNotices).toEqual([]);
  });

  it("keeps the owning tab scope through a portal", async () => {
    const link = render({ portal: true });
    expect(link.closest("[data-portal]")).not.toBeNull();
    await activate(() => link.click());
    expect(launch).toHaveBeenCalledExactlyOnceWith(MAIN_URI);
  });

  it.each(["browser", "Electron browser", "remote", "unknown owner", "null state"])("copies in %s with adjacent two-second feedback", async (owner) => {
    vi.useFakeTimers();
    if (owner === "browser") platform.electron = false;
    if (owner === "Electron browser") platform.webTransport = true;
    if (owner === "remote") useStore.setState({ state: remoteOwnedState(REMOTE_TAB, REMOTE) });
    if (owner === "null state") useStore.setState({ state: null });
    const link = render({ tabId: owner === "remote" ? REMOTE_TAB : owner === "unknown owner" ? "missing-tab" : TAB });
    expect(link.title).toBe(t("transcript.vault.copyTitle"));
    await activate(() => link.click());
    expect(launch).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PORTABLE_URI);
    expect(link.textContent).toBe("Exact note");
    const status = document.body.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe(t("transcript.vault.linkCopied"));
    act(() => vi.advanceTimersByTime(1999));
    expect(status.textContent).toBe(t("transcript.vault.linkCopied"));
    act(() => vi.advanceTimersByTime(1));
    expect(status.textContent).toBe("");
  });

  it.each(["no tab", "no handler"])("copies with %s even in local Electron", async (policy) => {
    mount(<OpenInObsidianLink vaultName="Notes" file={FILE} tabId={policy === "no tab" ? undefined : TAB} uriHandler={policy === "no handler" ? false : undefined}>Exact note</OpenInObsidianLink>);
    await activate(() => host.querySelector("a")!.click());
    expect(launch).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PORTABLE_URI);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(t("transcript.vault.linkCopied"));
  });

  it("routes each provider by its own tab rather than another tab's owner", async () => {
    const remote = remoteOwnedState(REMOTE_TAB, REMOTE);
    useStore.setState({ state: { ...localState(), remoteInstances: remote.remoteInstances } });
    mount(<>
      <MarkdownVaultProvider tabId={TAB}><Markdown text={obsidianReplyLink("Notes", FILE, "Local note")} /></MarkdownVaultProvider>
      <MarkdownVaultProvider tabId={REMOTE_TAB}><Markdown text={obsidianReplyLink("Notes", FILE, "Remote note")} /></MarkdownVaultProvider>
    </>);
    const links = host.querySelectorAll("a");
    await activate(() => links[1]!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PORTABLE_URI);
    expect(launch).not.toHaveBeenCalled();
    await activate(() => links[0]!.click());
    expect(launch).toHaveBeenCalledExactlyOnceWith(MAIN_URI);
  });

  it.each(["absent", "rejected"])("tries the clipboard fallback when the API is %s", async (clipboard) => {
    platform.electron = false;
    if (clipboard === "absent") Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    else writeText.mockRejectedValue(new Error("Clipboard refused"));
    let selected = "";
    execCommand.mockImplementation(() => {
      selected = document.querySelector("textarea")!.value;
      return true;
    });
    const link = render();
    link.focus();
    await activate(() => link.click());
    expect(execCommand).toHaveBeenCalledExactlyOnceWith("copy");
    expect(selected).toBe(PORTABLE_URI);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(link);
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe(t("transcript.vault.linkCopied"));
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["absent", "rejected"])("shows a selectable portable URI and focused retry after %s clipboard and refused fallback", async (clipboard) => {
    platform.electron = false;
    if (clipboard === "absent") Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    else writeText.mockRejectedValue(new Error("Clipboard refused"));
    const link = render();
    link.focus();
    await activate(() => link.click());
    const fallback = link.parentElement!.querySelector("[data-selectable]")!;
    expect(fallback.tagName).toBe("SPAN");
    expect(fallback.textContent).toBe(PORTABLE_URI);
    expect(link.closest("p")?.contains(fallback)).toBe(true);
    expect(link.textContent).toBe("Exact note");
    expect(document.activeElement).toBe(link);
    expect(launch).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    writeText.mockResolvedValue(undefined);
    await activate(() => link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(link.parentElement!.querySelector("[data-selectable]")).toBeNull();
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe(t("transcript.vault.linkCopied"));
    expect(document.activeElement).toBe(link);
  });

  it("blocks auxiliary, drag and context-menu navigation", async () => {
    const cardClick = vi.fn();
    const link = render({ onCardClick: cardClick });
    for (const type of ["auxclick", "dragstart", "contextmenu"]) {
      const event = new MouseEvent(type, { button: 1, bubbles: true, cancelable: true });
      await activate(() => link.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(launch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(cardClick).not.toHaveBeenCalled();
  });

  it("clears copied feedback timers on unmount", async () => {
    platform.electron = false;
    vi.useFakeTimers();
    const link = render();
    await activate(() => link.click());
    expect(vi.getTimerCount()).toBe(1);
    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a timer when a pending clipboard resolves after unmount", async () => {
    platform.electron = false;
    vi.useFakeTimers();
    let resolveCopy!: () => void;
    writeText.mockReturnValue(new Promise<void>((resolve) => { resolveCopy = resolve; }));
    const link = render();
    await activate(() => link.click());
    act(() => root!.unmount());
    root = null;
    await act(async () => resolveCopy());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["unknown vault", "unknown vault"],
    ["missing note", "note not found"],
    ["hidden alias", "hidden real targets"],
    ["escaping symlink", "path leaves the vault"],
    ["main opener", "OS opener refused"],
  ])("reports %s failures through the store without copying", async (failure, message) => {
    let file = FILE;
    let vault = "Notes";
    if (failure === "unknown vault") vault = "Missing vault";
    if (failure === "missing note") file = "nested/Missing.md";
    if (failure === "hidden alias") {
      file = "nested/Hidden alias.md";
      fs.symlinkSync(path.join(vaultReal, ".obsidian", "Hidden.md"), path.join(vaultReal, file));
    }
    if (failure === "escaping symlink") {
      file = "nested/Outside.md";
      const outside = path.join(vaultBase, "Outside.md");
      fs.writeFileSync(outside, "Outside\n");
      fs.symlinkSync(outside, path.join(vaultReal, file));
    }
    if (failure === "main opener") launch.mockRejectedValue(new Error("OS opener refused"));
    const link = render({ vault, file });
    await activate(() => link.click());
    expect(useStore.getState().errorNotices).toHaveLength(1);
    expect(useStore.getState().errorNotices[0]!.message).toContain(message);
    expect(writeText).not.toHaveBeenCalled();
    expect(link.parentElement!.querySelector("[data-selectable]")).toBeNull();
    if (failure === "main opener") expect(launch).toHaveBeenCalledExactlyOnceWith(MAIN_URI);
    else expect(launch).not.toHaveBeenCalled();
  });
});
