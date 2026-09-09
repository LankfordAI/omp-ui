// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteInstanceInput } from "@omp-ui/core/types";
import { backendState, remoteInstance } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  addRemoteInstance: vi.fn<(input: RemoteInstanceInput) => Promise<void>>(async () => {}),
  updateRemoteInstance: vi.fn(async () => {}),
  removeRemoteInstance: vi.fn(async () => {}),
  reconnectRemoteInstance: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../../store");
const { RemoteInstancesPage } = await import("./RemoteInstancesPage");

let root: Root | null = null;

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RemoteInstancesPage />));
}

function input(label: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (found === null) throw new Error(`input not found: ${label}`);
  return found;
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) throw new Error(`button not found: ${text}`);
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
  backendMock.addRemoteInstance.mockReset();
  backendMock.addRemoteInstance.mockResolvedValue(undefined);
  useStore.setState({ state: backendState(), lifecycleConfirmation: null, errorNotices: [] });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("RemoteInstancesPage (issue #416)", () => {
  it("derives the nickname placeholder from the URL host and joins with a password", async () => {
    render();
    expect(document.body.textContent).toContain("No remote instances joined");
    const url = input("Connection URL");
    await typeInto(url, "http://box-a.tailnet:4677/");
    expect(input("Nickname").placeholder).toBe("box-a.tailnet:4677");
    expect(document.body.textContent).toContain("Defaults to box-a.tailnet:4677");

    // Nothing to join with yet: the button waits for a secret.
    expect(button("Join").disabled).toBe(true);
    await typeInto(input("Password"), "hunter2");
    await act(async () => button("Join").click());
    expect(backendMock.addRemoteInstance).toHaveBeenCalledWith({
      url: "http://box-a.tailnet:4677/",
      nickname: "",
      secret: { kind: "password", value: "hunter2" },
    });
    // Success clears the form for the next join.
    expect(input("Connection URL").value).toBe("");
  });

  it("takes the token from a pasted token link and hides the secret field", async () => {
    render();
    await typeInto(input("Connection URL"), "http://box-b:4677/?t=abc123");
    expect(document.body.querySelector('input[aria-label="Password"]')).toBeNull();
    expect(document.body.textContent).toContain("carries an access token");
    await typeInto(input("Nickname"), "Box B");
    await act(async () => button("Join").click());
    expect(backendMock.addRemoteInstance).toHaveBeenCalledWith({
      url: "http://box-b:4677/?t=abc123",
      nickname: "Box B",
      secret: { kind: "token", value: "abc123" },
    });
  });

  it("shows a rejected join inline and keeps the entry", async () => {
    backendMock.addRemoteInstance.mockRejectedValue(
      new Error("Error invoking remote method 'remote-instance:add': Error: Wrong password."),
    );
    render();
    await typeInto(input("Connection URL"), "http://box-a:4677");
    await typeInto(input("Password"), "nope");
    await act(async () => button("Join").click());
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Wrong password.");
    expect(input("Connection URL").value).toBe("http://box-a:4677");
    expect(useStore.getState().errorNotices).toEqual([]);
  });

  it("lists joined instances with status and stages removal through the lifecycle confirmation", async () => {
    useStore.setState({
      state: backendState({
        remoteInstances: [
          remoteInstance({ id: "inst-a", nickname: "box-a", status: "needs-sign-in", error: "credential rejected" }),
        ],
      }),
    });
    render();
    expect(document.body.textContent).toContain("box-a");
    expect(document.body.textContent).toContain("sign-in required");
    expect(document.body.textContent).toContain("credential rejected");
    act(() => button("Remove").click());
    expect(useStore.getState().lifecycleConfirmation).toMatchObject({
      kind: "remove-remote-instance",
      instanceId: "inst-a",
      nickname: "box-a",
    });
    expect(backendMock.removeRemoteInstance).not.toHaveBeenCalled();
  });
});
