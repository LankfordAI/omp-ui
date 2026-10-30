// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord, RemoteState } from "@omp-ui/core/types";
import type { WebhookInput, WebhookSecretReveal, WebhookSummary, WebhooksState } from "@omp-ui/core/webhook";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getState: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  createWebhook: vi.fn<(input: WebhookInput) => Promise<WebhookSecretReveal>>(),
  updateWebhook: vi.fn(async () => {}),
  rotateWebhookSecret: vi.fn<(id: string) => Promise<WebhookSecretReveal>>(),
  removeWebhook: vi.fn(async () => {}),
  setWebhooksEnabled: vi.fn(async () => {}),
  clearWebhookDeliveries: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../../store");
const { WebhooksPage } = await import("./WebhooksPage");

const SECRET = "whsec-only-once-7f3a";

const webhook: WebhookSummary = {
  id: "AbCdEfGhIjKlMnOpQrStUv",
  name: "CI failures",
  machineKey: "local",
  projectCwd: "/work/app",
  template: "Triage this failure.",
  mode: "plan",
  workspace: "worktree",
  auth: "hmac",
  enabled: true,
  ratePerHour: 6,
  createdAt: "2026-10-30T00:00:00.000Z",
  secretReadable: true,
};

const listening: RemoteState = {
  status: "listening",
  enabled: true,
  bind: "lan",
  port: 4677,
  token: "tok123",
  hasPassword: false,
  urls: ["http://192.168.1.5:4677/?token=tok123"],
  tokenUrls: [],
  webBundleMissing: false,
  error: null,
};

const emptyWebhooks: WebhooksState = { enabled: true, credentialStore: true, webhooks: [], deliveries: [] };

let root: Root | null = null;

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<WebhooksPage />));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found;
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  backendMock.createWebhook.mockReset();
  const project = { path: "/work/app", name: "app" } as ProjectRecord;
  useStore.setState({
    state: backendState({ projects: [{ project, sessions: [] }] }),
    remote: listening,
    webhooks: emptyWebhooks,
    errorNotices: [],
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("WebhooksPage (issue #997)", () => {
  it("shows the created secret once and forgets it on Done", async () => {
    backendMock.createWebhook.mockResolvedValue({ webhook, secret: SECRET });
    render();
    await typeInto(document.body.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "CI failures");
    await typeInto(
      document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt template"]')!,
      "Triage this failure.",
    );
    await act(async () => button("Create").click());

    expect(backendMock.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ name: "CI failures", machineKey: "local", projectCwd: "/work/app", mode: "plan" }),
    );
    expect(document.body.textContent).toContain(SECRET);
    expect(document.body.textContent).toContain("X-Hub-Signature-256");

    await act(async () => button("Done").click());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("builds the endpoint URL from the listener origin without the token query", () => {
    useStore.setState({ webhooks: { ...emptyWebhooks, webhooks: [webhook] } });
    render();
    expect(document.body.textContent).toContain(`http://192.168.1.5:4677/webhooks/${webhook.id}`);
    expect(document.body.textContent).not.toContain("tok123");
  });
});
