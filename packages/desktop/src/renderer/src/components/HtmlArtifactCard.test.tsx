// @vitest-environment node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactResolvedSurface } from "../../../main/artifact-service";
import { ArtifactService } from "../../../main/artifact-service";
import { HostBridge } from "../../../main/host-bridge";
import { artifactSourceHash } from "../../../main/artifact-source";
import type { ArtifactPreparedSurface } from "../../../artifact-runtime-protocol";
import { HTML_ARTIFACT_DEFAULT_HEIGHT, HTML_ARTIFACT_MAX_HEIGHT, HTML_ARTIFACT_PARTITION } from "@omp-ui/core/html-artifact";
import type { ToolItem } from "../lib/transcript";
import { backendState, remoteOwnedState } from "../test/fixtures";

// Main's real artifact store uses node:sqlite. Supply the renderer DOM without
// replacing the service, host admission, persistence, or WebCrypto hash path.
const dom: { window: Window & typeof globalThis } = new (createRequire(import.meta.url)("jsdom").JSDOM)("", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLIFrameElement", "HTMLAnchorElement", "HTMLTextAreaElement", "KeyboardEvent", "MouseEvent", "Event", "CustomEvent", "localStorage"] as const) {
  vi.stubGlobal(key, dom.window[key]);
}
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ electron: true }));

vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

let artifactService: ArtifactService;
const backendMock = {
  artifactResolveSource: vi.fn(async (request: Parameters<ArtifactService["resolveSource"]>[0]) => artifactService.resolveSource(request)),
  artifactKeep: vi.fn(async (request: Parameters<ArtifactService["keep"]>[0]) => artifactService.keep(request)),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { HtmlArtifactCard } = await import("./HtmlArtifactCard");

let root: Root | null = null;
const TAB = "artifact-file-tab";
const TOOL_CALL = "file-backed-call";
const SESSION = "11111111-1111-4111-8111-111111111111";
const RUNTIME = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const cleanups: (() => void)[] = [];

function artifact(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "call-1",
    name: "omp-ui_render_html",
    args: { title: "Chart", html: "<script>draw()</script><canvas></canvas>" },
    status: "done",
    ...overrides,
  };
}

function render(item: ToolItem, tabId?: string, deferred?: boolean): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<HtmlArtifactCard item={item} tabId={tabId} deferred={deferred} />));
  return host;
}

/** Replay a guest height report: Electron puts the target URL on the event. */
function reportHeight(el: Element, url: string): void {
  act(() => {
    el.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url }));
  });
}

function frameStyle(el: Element | null, prop: "height"): string | null {
  return el instanceof HTMLElement ? el.style[prop] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.electron = true;
  useStore.setState({ state: backendState({ htmlArtifactScripts: true }), activeTabId: TAB });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  delete window.ompArtifactHost;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("HtmlArtifactCard retained file-backed draft", () => {
  it("finds a done call without draft metadata by its raw WebCrypto hash and Keeps persisted data", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-card-"));
    const lineageDir = path.join(directory, "lineage");
    const stem = `2026-11-09T00-00-00-000Z_${SESSION}`;
    const transcript = path.join(lineageDir, `${stem}.jsonl`);
    const localRoot = path.join(lineageDir, stem, "local");
    fs.mkdirSync(localRoot, { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", id: SESSION })}\n`);
    const dataFile = path.join(localRoot, "rows.json");
    const rows = [{ label: "Retained import", quantity: 12 }];
    fs.writeFileSync(dataFile, JSON.stringify(rows));
    const options = {
      registryFile: path.join(directory, "registry.json"),
      artifactsRoot: path.join(directory, "artifacts"),
      ownerInstanceId: () => OWNER,
      enabled: () => true,
      scriptsEnabled: () => true,
      resolveTarget: () => ({ ownerInstanceId: OWNER, lineageDir, sessionId: SESSION, runtimeKey: RUNTIME,
        native: true, originContext: { kind: "chat" as const } }),
      sourcePath: async () => transcript,
      sources: () => [{ lineageDir }],
    };
    artifactService = new ArtifactService(options);
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }), () => artifactService.close());
    const bridge = new HostBridge({
      artifacts: artifactService,
      readPlanFile: async () => ({ ok: false, reason: "unreadable" }),
      planSnapshot: () => null,
      planRoot: () => lineageDir,
      notify: () => "posted",
      capabilitySessionId: () => SESSION,
      log: () => {},
    });
    cleanups.push(() => bridge.forget(TAB));
    const rawArgs = {
      title: "  Imported inventory  ", height: 5000,
      html: "<pre id='rows'></pre><script>window.ompArtifact.load().then(snapshot => { document.getElementById('rows').textContent = JSON.stringify(snapshot.datasets.rows.value); });</script>",
      artifact: {
        protocolVersion: 1, stateSchema: "inventory-state-v1", initialState: {},
        datasets: [{ id: "rows", title: "Inventory rows", schema: "inventory-v1", valueFile: "local://rows.json",
          provenance: { source: { kind: "file", label: "Inventory export" },
            method: { kind: "import", description: "Import inventory JSON" },
            refresh: { kind: "manual", requiredSources: [] } } }],
      },
    };
    const original = JSON.stringify(rawArgs);
    const rawHash = artifactSourceHash(rawArgs);
    const sent = Promise.withResolvers<Parameters<Parameters<HostBridge["route"]>[2]>[0]>();
    bridge.route(TAB, { type: "message_end", message: { role: "assistant", content: [
      { type: "toolCall", id: TOOL_CALL, name: "omp-ui_render_html", arguments: rawArgs },
    ] } }, sent.resolve);
    bridge.route(TAB, { type: "host_tool_call", id: "file-render-answer", toolCallId: TOOL_CALL,
      toolName: "omp-ui_render_html", arguments: rawArgs }, sent.resolve);
    expect(await sent.promise).toMatchObject({ type: "host_tool_result", result: { details: {
      artifactDraft: { version: 1, sourceHash: rawHash },
    } } });
    const lookup = await artifactService.resolveSource({ tabId: TAB, sessionId: SESSION, toolCallId: TOOL_CALL, sourceHash: rawHash });
    expect(lookup.status).toBe("draft");
    if (lookup.status !== "draft") throw new Error("Host did not stage the file-backed draft");
    const draft = lookup.draft;
    expect(draft.source.sourceHash).toBe(rawHash);
    expect(JSON.stringify(rawArgs)).toBe(original);
    expect(rawArgs.artifact.datasets[0]).not.toHaveProperty("value");
    expect(artifactService.list().artifacts).toEqual([]);

    // Both mutation and removal happen before rendering; replay must not re-read
    // the authoring path or trust inline authoring data. Reopen the real store.
    fs.writeFileSync(dataFile, JSON.stringify([{ label: "Changed after staging", quantity: 999 }]));
    fs.unlinkSync(dataFile);
    artifactService.close();
    artifactService = new ArtifactService(options);
    const prepared: ArtifactResolvedSurface[] = [];
    const prepareSurface = vi.fn(async (source: Parameters<ArtifactService["resolveSurface"]>[0]): Promise<ArtifactPreparedSurface> => {
      const resolved = artifactService.resolveSurface(source);
      prepared.push(resolved);
      return { surfaceId: draft.draftId, url: "data:text/html;base64,bWFuYWdlZA==", partition: HTML_ARTIFACT_PARTITION,
        managed: resolved.managed, readOnly: resolved.readOnly };
    });
    window.ompArtifactHost = { prepareSurface, releaseSurface: vi.fn(async () => {}),
      updateTheme: vi.fn(async () => {}), onSurfaceNotice: () => () => {} };
    const localProject = remoteOwnedState(TAB, "unused-remote").remoteInstances[0]!.projects[0]!;
    const session = localProject.sessions[0]!;
    useStore.setState({ state: backendState({ artifactLibraryEnabled: true, htmlArtifactScripts: true,
      projects: [{ ...localProject, sessions: [{ ...session, sessionId: SESSION, lineageDir }] }] }), activeTabId: TAB });
    const item = artifact({ toolCallId: TOOL_CALL, args: rawArgs });
    expect(item.status).toBe("done");
    expect(item).not.toHaveProperty("artifactDraft");
    const host = render(item, TAB);
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(prepareSurface).toHaveBeenCalledTimes(1);
    });
    expect(backendMock.artifactResolveSource).toHaveBeenCalledWith({ tabId: TAB, sessionId: SESSION,
      toolCallId: TOOL_CALL, sourceHash: draft.source.sourceHash });
    expect(prepareSurface).toHaveBeenCalledWith({ draftId: draft.draftId }, expect.any(Object));
    expect(prepared[0]?.datasets.rows?.value).toEqual(rows);
    expect(prepared[0]?.datasets.rows?.provenance).toMatchObject({ captureSessionId: SESSION, captureToolCallId: TOOL_CALL, trust: "agent-reported" });
    expect(host.querySelector("webview")?.getAttribute("partition")).toBe(HTML_ARTIFACT_PARTITION);
    expect(host.querySelector("webview")?.getAttribute("src")).toBe("data:text/html;base64,bWFuYWdlZA==");
    const keep = [...host.querySelectorAll("button")].find(button => button.textContent === "Keep");
    expect(keep).toBeDefined();
    await act(async () => { keep!.click(); });
    expect(backendMock.artifactKeep).toHaveBeenCalledWith({ draftId: draft.draftId, title: "Imported inventory" });
    expect(host.textContent).toContain("Open in library");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(prepareSurface).toHaveBeenCalledTimes(1);
    const kept = artifactService.list().artifacts[0]!;
    expect(artifactService.list().artifacts).toHaveLength(1);
    artifactService.close();
    artifactService = new ArtifactService(options);
    const accepted = artifactService.resolveSurface({ artifactId: kept.artifactId,
      codeRevisionId: kept.currentCodeRevisionId, dataSnapshotId: kept.currentDataSnapshotId });
    expect(accepted.datasets.rows?.value).toEqual(rows);
    expect(accepted.datasets.rows).not.toHaveProperty("valueFile");
    expect(artifactService.describe({ artifactId: kept.artifactId }).code.source.sourceHash).toBe(rawHash);
    expect(JSON.stringify(rawArgs)).toBe(original);
  });
});

describe("HtmlArtifactCard surface", () => {
  it("runs scripts only in a guest on the locked artifact partition", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview");
    expect(guest?.getAttribute("partition")).toBe(HTML_ARTIFACT_PARTITION);
    expect(guest?.getAttribute("src")).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    expect(host.querySelector("iframe")).toBeNull();
  });

  it.each([
    ["the scripts setting is off", true, false],
    ["the viewer is a browser client", false, true],
  ])("never runs a script when %s", (_label, electron, setting) => {
    mocks.electron = electron;
    useStore.setState({ state: backendState({ htmlArtifactScripts: setting }) });
    const host = render(artifact());
    expect(host.querySelector("webview")).toBeNull();
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain("script-src 'none'");
  });

  it("shows no document for a refused or still-streaming call", () => {
    for (const item of [
      artifact({ args: { title: "Chart" }, status: "error", resultText: "render_html refused: html must be a non-empty string" }),
      artifact({ status: "running" }),
    ]) {
      const host = render(item);
      expect(host.querySelector("webview, iframe")).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
  });

  it("holds a deferred artifact as a one-line note with no guest", () => {
    const host = render(artifact(), undefined, true);
    expect(host.textContent).toContain("Chart");
    expect(host.querySelector("webview, iframe")).toBeNull();
  });
});

describe("HtmlArtifactCard flush posture", () => {
  it("wears no chrome: no header, chip, or height steppers", () => {
    const host = render(artifact());
    expect(host.textContent).not.toContain("interactive");
    expect(host.querySelector('[aria-label="Taller"]')).toBeNull();
    expect(host.querySelector('[aria-label="Shorter"]')).toBeNull();
    // The document keeps its accessible name, and expand survives on the pill.
    expect(host.querySelector("h3.sr-only")?.textContent).toBe("Chart");
    expect(host.querySelector('[aria-label="Expand to full view"]')).not.toBeNull();
  });

  it("sizes the frame from the guest height channel", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview");
    // Before the first report, the requested hint height shows.
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_DEFAULT_HEIGHT}px`);
    reportHeight(guest!, "#omph640");
    expect(frameStyle(guest, "height")).toBe("640px");
  });

  it("clamps a reported height to the inline cap", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview")!;
    reportHeight(guest, "data:text/html;charset=utf-8;base64,AAA#omph99999");
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_MAX_HEIGHT}px`);
  });

  it("ignores a fragment navigation that is not a height report", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview")!;
    reportHeight(guest, "about:blank#section-2");
    reportHeight(guest, "#omphNaN");
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_DEFAULT_HEIGHT}px`);
  });

  it("keeps the requested height for the static iframe, which has no stub", () => {
    mocks.electron = false;
    useStore.setState({ state: backendState({ htmlArtifactScripts: true }) });
    const host = render(artifact({ args: { title: "Chart", html: "<b>x</b>", height: 500 } }));
    const frame = host.querySelector("iframe")!;
    expect(frameStyle(frame, "height")).toBe("500px");
    reportHeight(frame, "#omph640");
    expect(frameStyle(frame, "height")).toBe("500px");
  });

  it("shows a faint running line with no guest", () => {
    const host = render(artifact({ status: "running" }));
    expect(host.querySelector("webview, iframe")).toBeNull();
    expect(host.textContent).toContain("running");
    expect(host.querySelector(".animate-rise .h-px")).not.toBeNull();
  });

  it("shows the failure slab bare with no guest", () => {
    const host = render(
      artifact({ status: "error", resultText: "render_html refused: html must be a non-empty string" }),
    );
    expect(host.querySelector("webview, iframe")).toBeNull();
    expect(host.textContent).toContain("html must be a non-empty string");
  });
});
