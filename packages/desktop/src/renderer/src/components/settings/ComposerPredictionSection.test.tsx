// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpSettingEntry, OmpSettingValue } from "@omp-ui/core/types";
import {
  COMPOSER_PREDICTION_ALTERNATIVES_KEY,
  COMPOSER_PREDICTIONS_KEY,
} from "@omp-ui/core/omp-settings-keys";
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
Object.assign(window, { ompBackend: {} });
const { useStore } = await import("../../store");
const { ComposerPredictionSection } = await import("./ComposerPredictionSection");

function predictionEntry(
  key: string,
  value: OmpSettingValue,
  globalValue: OmpSettingValue = value,
  layer: OmpSettingEntry["layer"] = "global",
): OmpSettingEntry {
  return {
    key,
    type: "boolean",
    description: "",
    value,
    globalValue,
    options: null,
    layer,
  };
}

let root: Root | null = null;

function mount(
  masterEntry: OmpSettingEntry | undefined,
  alternativesEntry: OmpSettingEntry | undefined,
  commit = vi.fn(),
  pendingKey: string | null = null,
): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ComposerPredictionSection
        masterEntry={masterEntry}
        alternativesEntry={alternativesEntry}
        pendingKey={pendingKey}
        commit={commit}
      />,
    ),
  );
  return host;
}

function switchFor(key: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="${key}"]`,
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ state: backendState() });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("ComposerPredictionSection (#1030)", () => {
  it("renders nothing when the binary predates composer.predictions", () => {
    const publishedAlt = predictionEntry(COMPOSER_PREDICTION_ALTERNATIVES_KEY, true);
    for (const alternativesEntry of [undefined, publishedAlt]) {
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      act(() =>
        root!.render(
          <ComposerPredictionSection
            masterEntry={undefined}
            alternativesEntry={alternativesEntry}
            pendingKey={null}
            commit={vi.fn()}
          />,
        ),
      );
      expect(host.querySelector("section")).toBeNull();
      expect(document.body.querySelectorAll('button[role="switch"]')).toHaveLength(0);
      act(() => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });

  it("lists only the master row while predictions read off", () => {
    mount(predictionEntry(COMPOSER_PREDICTIONS_KEY, false), predictionEntry(COMPOSER_PREDICTION_ALTERNATIVES_KEY, true));
    const masterSwitch = switchFor(COMPOSER_PREDICTIONS_KEY);
    expect(masterSwitch).not.toBeNull();
    expect(masterSwitch?.getAttribute("aria-checked")).toBe("false");
    expect(switchFor(COMPOSER_PREDICTION_ALTERNATIVES_KEY)).toBeNull();
  });

  it("lists the alternatives row while the master reads on", () => {
    mount(predictionEntry(COMPOSER_PREDICTIONS_KEY, true), predictionEntry(COMPOSER_PREDICTION_ALTERNATIVES_KEY, false));
    expect(switchFor(COMPOSER_PREDICTIONS_KEY)?.getAttribute("aria-checked")).toBe("true");
    const altSwitch = switchFor(COMPOSER_PREDICTION_ALTERNATIVES_KEY);
    expect(altSwitch).not.toBeNull();
    expect(altSwitch?.getAttribute("aria-checked")).toBe("false");
  });

  it("hides the alternatives row when the binary predates it", () => {
    mount(predictionEntry(COMPOSER_PREDICTIONS_KEY, true), undefined);
    expect(switchFor(COMPOSER_PREDICTIONS_KEY)).not.toBeNull();
    expect(switchFor(COMPOSER_PREDICTION_ALTERNATIVES_KEY)).toBeNull();
  });

  it("flipping a switch commits at the global layer", async () => {
    const commit = vi.fn();
    mount(
      predictionEntry(COMPOSER_PREDICTIONS_KEY, false),
      predictionEntry(COMPOSER_PREDICTION_ALTERNATIVES_KEY, true),
      commit,
    );
    const masterSwitch = switchFor(COMPOSER_PREDICTIONS_KEY);
    expect(masterSwitch).not.toBeNull();
    await click(masterSwitch!);
    expect(commit).toHaveBeenLastCalledWith(COMPOSER_PREDICTIONS_KEY, true);
    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    mount(
      predictionEntry(COMPOSER_PREDICTIONS_KEY, true),
      predictionEntry(COMPOSER_PREDICTION_ALTERNATIVES_KEY, true),
      commit,
    );
    const altSwitch = switchFor(COMPOSER_PREDICTION_ALTERNATIVES_KEY);
    expect(altSwitch).not.toBeNull();
    await click(altSwitch!);
    expect(commit).toHaveBeenLastCalledWith(COMPOSER_PREDICTION_ALTERNATIVES_KEY, false);
    expect(commit).toHaveBeenCalledTimes(2);
  });
});
