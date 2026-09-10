// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsPreview } from "@omp-ui/core/types";
import { installDesktopAdapter } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// desktop.ts reads window.ompDesktop at module load, so the desktop identity must exist before
// the component import below; the web-client case re-imports the module graph without it.
const backendMock = {
  previewDiagnosticsBundle: vi.fn(),
  exportDiagnosticsBundle: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
const desktopMock = installDesktopAdapter();

const { useStore } = await import("../store");
const { DiagnosticsExportDialog } = await import("./DiagnosticsExportDialog");

let root: Root;
let host: HTMLElement;

const preview: DiagnosticsPreview = {
  sections: [
    {
      id: "logs",
      prefix: "logs/",
      included: true,
      files: [{ name: "main.log", sizeBytes: 2048 }],
      totalBytes: 2048,
    },
    {
      id: "transcripts",
      prefix: "transcripts/",
      included: false,
      files: [],
      totalBytes: 0,
    },
  ],
  totalBytes: 2048,
  warnings: [],
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  backendMock.previewDiagnosticsBundle.mockReset().mockResolvedValue(preview);
  backendMock.exportDiagnosticsBundle.mockReset();
  desktopMock.chooseSavePath.mockReset().mockResolvedValue(null);
  useStore.setState({ errorNotices: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function open(): void {
  act(() => {
    root.render(<DiagnosticsExportDialog />);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The primary (last) footer button. */
function primary(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>("footer button:last-of-type")!;
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("DiagnosticsExportDialog", () => {
  it("renders preview rows with file counts and human sizes", async () => {
    open();
    await settle();
    expect(backendMock.previewDiagnosticsBundle).toHaveBeenCalledOnce();
    const text = document.body.textContent ?? "";
    expect(text).toContain("logs");
    expect(text).toContain("2.0 KiB");
    const rowIds = [...document.querySelectorAll("li > span:first-child")].map((n) =>
      n.textContent,
    );
    expect(rowIds).toEqual(["logs"]);
  });

  it("routes a preview rejection to the error notices and offers retry", async () => {
    backendMock.previewDiagnosticsBundle.mockRejectedValueOnce(new Error("disk on fire"));
    open();
    await settle();
    expect(useStore.getState().errorNotices.map((n) => n.message)).toContain("disk on fire");
    expect(document.body.textContent).toContain("Retry");
    await click(primary());
    await settle();
    expect(backendMock.previewDiagnosticsBundle).toHaveBeenCalledTimes(2);
  });

  it("reveals the transcripts warning when the checkbox is ticked", async () => {
    open();
    await settle();
    const box = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(document.body.textContent).not.toContain("full conversation text");
    await act(async () => {
      box.click();
    });
    expect(document.body.textContent).toContain("full conversation text");
  });

  it("desktop save flow calls choose then export with the chosen path", async () => {
    desktopMock.chooseSavePath.mockResolvedValue("/home/u/bundle.zip");
    backendMock.exportDiagnosticsBundle.mockResolvedValue({
      path: "/home/u/bundle.zip",
      totalBytes: 123,
      warnings: [],
    });
    open();
    await settle();
    await click(primary());
    expect(desktopMock.chooseSavePath).toHaveBeenCalledWith("omp-ui-diagnostics.zip", ["zip"]);
    expect(backendMock.exportDiagnosticsBundle).toHaveBeenCalledWith({
      includeTranscripts: false,
      destinationPath: "/home/u/bundle.zip",
    });
    // Done state: the written path shows.
    expect(document.body.textContent).toContain("/home/u/bundle.zip");
  });

  it("cancel in the save dialog exports nothing and keeps the dialog open", async () => {
    desktopMock.chooseSavePath.mockResolvedValue(null);
    open();
    await settle();
    await click(primary());
    expect(backendMock.exportDiagnosticsBundle).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sections");
  });

  it("export failure routes to reportError and stays open", async () => {
    desktopMock.chooseSavePath.mockResolvedValue("/x.zip");
    backendMock.exportDiagnosticsBundle.mockRejectedValue(
      new Error("Error invoking remote method 'diagnostics:export': Error: failed to write"),
    );
    open();
    await settle();
    await click(primary());
    expect(useStore.getState().errorNotices.map((n) => n.message)).toContain("failed to write");
    expect(document.body.textContent).toContain("Sections");
  });

  it("ignores repeat clicks while in flight", async () => {
    const { promise, resolve } = Promise.withResolvers<{
      path: string;
      totalBytes: number;
      warnings: string[];
    }>();
    desktopMock.chooseSavePath.mockResolvedValue("/y.zip");
    backendMock.exportDiagnosticsBundle.mockReturnValue(promise);
    open();
    await settle();
    const save = primary();
    await click(save);
    await click(save);
    expect(backendMock.exportDiagnosticsBundle).toHaveBeenCalledOnce();
    resolve({ path: "/y.zip", totalBytes: 1, warnings: [] });
    await settle();
  });
});

describe("web client", () => {
  afterEach(() => {
    vi.resetModules();
    window.ompDesktop = desktopMock;
  });

  it("skips the save dialog without an adapter, exports to the host's default path, and says so", async () => {
    vi.resetModules();
    delete window.ompDesktop;
    const fresh = await import("./DiagnosticsExportDialog");
    backendMock.exportDiagnosticsBundle.mockResolvedValue({
      path: "/host/diagnostics/omp-ui-diagnostics-x.zip",
      totalBytes: 1,
      warnings: [],
    });
    act(() => {
      root.render(<fresh.DiagnosticsExportDialog />);
    });
    await settle();
    const save = primary();
    expect(save.textContent).toBe("Create bundle");
    await click(save);
    expect(desktopMock.chooseSavePath).not.toHaveBeenCalled();
    expect(backendMock.exportDiagnosticsBundle).toHaveBeenCalledWith({
      includeTranscripts: false,
      destinationPath: null,
    });
    // The path is on the host's disk, not this browser's: plain text, no open/reveal affordance.
    expect(document.body.textContent).toContain("Saved on the host at");
    expect(document.body.textContent).toContain("/host/diagnostics/omp-ui-diagnostics-x.zip");
  });
});
