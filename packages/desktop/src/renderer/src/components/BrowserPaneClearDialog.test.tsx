// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPaneClearDataResult } from "@omp-ui/core/browser-pane";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  browserPaneClearData: vi.fn<(force: boolean) => Promise<BrowserPaneClearDataResult>>(),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { BrowserPaneClearDialog } = await import("./BrowserPaneClearDialog");
let root: Root;

beforeEach(() => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  backendMock.browserPaneClearData.mockReset();
  useStore.setState({ errorNotices: [] });
  act(() => root.render(<BrowserPaneClearDialog />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function clickPrimary(): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>("footer button:last-of-type")!.click();
  });
}

describe("BrowserPaneClearDialog", () => {
  it("offers a force pass for live pages and then shows completion", async () => {
    backendMock.browserPaneClearData
      .mockResolvedValueOnce({ status: "busy", openPages: 2 })
      .mockResolvedValueOnce({ status: "cleared" });
    await clickPrimary();
    expect(backendMock.browserPaneClearData).toHaveBeenLastCalledWith(false);
    expect(document.body.textContent).toContain("Pages are still open");
    await clickPrimary();
    expect(backendMock.browserPaneClearData).toHaveBeenLastCalledWith(true);
    expect(document.body.textContent).toContain("Browser pane data cleared");
  });

  it("reports a backend rejection as an error notice", async () => {
    backendMock.browserPaneClearData.mockRejectedValueOnce(new Error("partition failed"));
    await clickPrimary();
    expect(useStore.getState().errorNotices.map((notice) => notice.message)).toContain("partition failed");
  });
});
