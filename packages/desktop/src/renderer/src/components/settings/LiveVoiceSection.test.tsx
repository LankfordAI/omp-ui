// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import {
  LIVE_VOICE_SETTING_KEY,
  SPEECH_SPEED_SETTING_KEY,
} from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { LiveVoiceSection } = await import("./LiveVoiceSection");

function voiceEntry(): OmpSettingEntry {
  return {
    key: LIVE_VOICE_SETTING_KEY,
    type: "enum",
    description: "",
    value: "sol",
    globalValue: "sol",
    options: [],
    layer: "global",
  };
}

function speedEntry(value: OmpSettingValue): OmpSettingEntry {
  return {
    key: SPEECH_SPEED_SETTING_KEY,
    type: "number",
    description: "",
    value,
    globalValue: value,
    options: null,
    layer: "global",
  };
}

let root: Root | null = null;

function mount(commit = vi.fn()): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <LiveVoiceSection
        entry={voiceEntry()}
        speechSpeedEntry={speedEntry(1)}
        pendingKey={null}
        commit={commit}
      />,
    ),
  );
  return host;
}

function speedField(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(
    `input[aria-label="${SPEECH_SPEED_SETTING_KEY}"]`,
  );
  if (found === null) throw new Error("speed field not found");
  return found;
}

async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pressEnter(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    state: backendState(),
    ompUpdate: { ...useStore.getState().ompUpdate, installedVersion: null },
  });
});

const setInstalledVersion = (installedVersion: string | null): void => {
  useStore.setState((s) => ({ ompUpdate: { ...s.ompUpdate, installedVersion } }));
};

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("LiveVoiceSection speed clamp (issue #1198)", () => {
  it("clamps writes to the Phonon band on omp ≥ 18.21.0", async () => {
    setInstalledVersion("18.21.0");
    const commit = vi.fn();
    mount(commit);
    const field = speedField();
    await typeInto(field, "2");
    await pressEnter(field);
    expect(commit).toHaveBeenCalledWith(SPEECH_SPEED_SETTING_KEY, 1.3);
    await typeInto(field, "0.2");
    await pressEnter(field);
    expect(commit).toHaveBeenLastCalledWith(SPEECH_SPEED_SETTING_KEY, 0.8);
    await typeInto(field, "1.1");
    await pressEnter(field);
    expect(commit).toHaveBeenLastCalledWith(SPEECH_SPEED_SETTING_KEY, 1.1);
  });

  it("keeps the wide band on older omp", async () => {
    setInstalledVersion("18.18.7");
    const commit = vi.fn();
    mount(commit);
    const field = speedField();
    await typeInto(field, "2");
    await pressEnter(field);
    expect(commit).toHaveBeenCalledWith(SPEECH_SPEED_SETTING_KEY, 2);
    await typeInto(field, "3");
    await pressEnter(field);
    expect(commit).toHaveBeenLastCalledWith(SPEECH_SPEED_SETTING_KEY, 2.5);
  });

  it("keeps the wide band when the installed version is unknown", async () => {
    const commit = vi.fn();
    mount(commit);
    const field = speedField();
    await typeInto(field, "2");
    await pressEnter(field);
    expect(commit).toHaveBeenCalledWith(SPEECH_SPEED_SETTING_KEY, 2);
  });
});
