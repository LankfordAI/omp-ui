import { describe, expect, it, vi } from "vitest";
import type { AppReleaseInfo, AppUpdateState } from "@omp-ui/core";
import {
  deriveAppUpdateState,
  type AppUpdateEvent,
  type AppUpdateMachine,
} from "./app-update";

// app-update.ts imports electron's shell at module scope; stub it like
// app-update.test.ts does — nothing here calls it.
vi.mock("electron", () => ({
  shell: {
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  },
}));

const RELEASE: AppReleaseInfo = {
  version: "1.2.0",
  tag: "v1.2.0",
  url: "https://github.com/LankfordAI/omp-ui/releases/tag/v1.2.0",
  name: "omp-ui 1.2.0",
  assets: [],
};

const IDLE_STATE: AppUpdateState = {
  status: "idle",
  currentVersion: "1.0.0",
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  format: "deb",
  progress: null,
  downloadedPath: null,
  installOnQuit: false,
  error: null,
};

const machine = (over: Partial<AppUpdateMachine> = {}): AppUpdateMachine => ({
  state: IDLE_STATE,
  release: null,
  stage: null,
  ...over,
});

const step = (prev: AppUpdateMachine, event: AppUpdateEvent): AppUpdateMachine =>
  deriveAppUpdateState(prev, event);

describe("deriveAppUpdateState", () => {
  it("disabled sets only the status", () => {
    const prev = machine({ state: { ...IDLE_STATE, error: "stale", progress: 7 } });
    const { state } = step(prev, { t: "disabled" });
    expect(state.status).toBe("disabled");
    // Untouched fields survive the merge exactly as the old set(patch) did.
    expect(state.error).toBe("stale");
    expect(state.progress).toBe(7);
  });

  it("check-begin clears progress and error", () => {
    const prev = machine({
      state: { ...IDLE_STATE, status: "error", progress: 42, error: "boom" },
    });
    expect(step(prev, { t: "check-begin" })).toEqual({
      ...prev,
      state: { ...IDLE_STATE, status: "checking" },
    });
  });

  it("unreachable: manual reports the error, quiet returns to idle and keeps metadata", () => {
    const prev = machine({
      state: { ...IDLE_STATE, status: "checking", latestVersion: "1.2.0" },
    });
    const manual = step(prev, { t: "unreachable", manual: true }).state;
    expect(manual.status).toBe("error");
    expect(manual.error).toBe("could not reach GitHub");
    // Deliberate retention: the quiet arm keeps the stale offer metadata.
    const quiet = step(prev, { t: "unreachable", manual: false }).state;
    expect(quiet.status).toBe("idle");
    expect(quiet.latestVersion).toBe("1.2.0");
  });

  it("up-to-date: manual reports it, quiet returns to idle", () => {
    expect(step(machine(), { t: "up-to-date", manual: true }).state.status).toBe("up-to-date");
    expect(step(machine(), { t: "up-to-date", manual: false }).state.status).toBe("idle");
  });

  it("offer-dismissed returns to idle", () => {
    const prev = machine({ state: { ...IDLE_STATE, status: "checking" } });
    expect(step(prev, { t: "offer-dismissed" }).state.status).toBe("idle");
  });

  it("available publishes the release fields and adopts the release", () => {
    const next = step(machine(), { t: "available", release: RELEASE, format: "deb" });
    expect(next.state).toEqual({
      ...IDLE_STATE,
      status: "available",
      latestVersion: RELEASE.version,
      releaseUrl: RELEASE.url,
      releaseName: RELEASE.name,
      format: "deb",
    });
    expect(next.release).toBe(RELEASE);
  });

  it("stage-enter (visible) shows downloading; quiet keeps idle but records the release", () => {
    const visible = step(machine(), {
      t: "stage-enter",
      visible: true,
      release: RELEASE,
      format: "appimage",
    });
    expect(visible.state.status).toBe("downloading");
    expect(visible.state.latestVersion).toBe(RELEASE.version);
    expect(visible.state.format).toBe("appimage");
    expect(visible).toMatchObject({ release: RELEASE, stage: { visible: true } });

    const quiet = step(machine(), {
      t: "stage-enter",
      visible: false,
      release: RELEASE,
      format: "nsis",
    });
    expect(quiet.state.status).toBe("idle");
    expect(quiet).toMatchObject({ release: RELEASE, stage: { visible: false } });
  });

  it("stage-enter with visible=true reveals an in-flight quiet stage (V⇒S holds)", () => {
    const quiet = step(machine(), {
      t: "stage-enter",
      visible: false,
      release: RELEASE,
      format: "maczip",
    });
    const revealed = step(quiet, {
      t: "stage-enter",
      visible: true,
      release: RELEASE,
      format: "maczip",
    });
    expect(revealed.state.status).toBe("downloading");
    expect(revealed.stage).toEqual({ visible: true });
  });

  it("stage-progress reports downloading with a floored percent", () => {
    const prev = machine({ stage: { visible: true } });
    const { state } = step(prev, { t: "stage-progress", percent: 42 });
    expect(state.status).toBe("downloading");
    expect(state.progress).toBe(42);
  });

  it("stage-complete settles the stage and takes the version from the event", () => {
    const prev = machine({
      state: { ...IDLE_STATE, status: "downloading", progress: 90, error: "stale" },
      stage: { visible: true },
    });
    const next = step(prev, { t: "stage-complete", version: "1.2.0" });
    expect(next.state.status).toBe("downloaded");
    expect(next.state.latestVersion).toBe("1.2.0");
    expect(next.state.progress).toBeNull();
    expect(next.state.error).toBeNull();
    expect(next.stage).toBeNull();
  });

  it("stage-empty: visible reports up-to-date, quiet returns to idle; both settle the stage", () => {
    const visible = step(machine({ stage: { visible: true } }), { t: "stage-empty", visible: true });
    expect(visible.state.status).toBe("up-to-date");
    expect(visible.stage).toBeNull();
    const quiet = step(machine({ stage: { visible: false } }), { t: "stage-empty", visible: false });
    expect(quiet.state.status).toBe("idle");
    expect(quiet.stage).toBeNull();
  });

  it("manual stage-failed surfaces the error but RETAINS the progress number", () => {
    const prev = machine({
      state: { ...IDLE_STATE, status: "downloading", progress: 66 },
      stage: { visible: true },
    });
    const { state } = step(prev, { t: "stage-failed", visible: true, message: "offline" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("offline");
    expect(state.progress).toBe(66); // deliberate retention, mirroring the old patch
    expect(prev.stage).not.toBeNull();
  });

  it("stage-failed: a quiet failure returns to idle and keeps even the stale error", () => {
    const prev = machine({
      state: { ...IDLE_STATE, error: "older failure" },
      stage: { visible: false },
    });
    const next = step(prev, { t: "stage-failed", visible: false, message: "offline" });
    expect(next.state.status).toBe("idle");
    expect(next.state.error).toBe("older failure"); // deliberate retention
    expect(next.stage).toBeNull();
  });

  it("installing clears progress and error", () => {
    const prev = machine({
      state: { ...IDLE_STATE, status: "downloaded", progress: 3, error: "stale" },
    });
    const { state } = step(prev, { t: "installing" });
    expect(state.status).toBe("installing");
    expect(state.progress).toBeNull();
    expect(state.error).toBeNull();
  });

  it("apply-failed prefixes the handoff error", () => {
    const { state } = step(machine(), { t: "apply-failed", message: "boom" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("could not apply update: boom");
  });

  it("install-on-quit mirrors the user intent", () => {
    expect(step(machine(), { t: "install-on-quit", on: true }).state.installOnQuit).toBe(true);
    const prev = machine({ state: { ...IDLE_STATE, installOnQuit: true } });
    expect(step(prev, { t: "install-on-quit", on: false }).state.installOnQuit).toBe(false);
  });

  it("asset failures carry their fixed messages", () => {
    expect(step(machine(), { t: "asset-missing" }).state.error).toBe(
      "expected asset missing from release",
    );
    expect(step(machine(), { t: "checksums-missing" }).state.error).toBe(
      "release checksums unavailable",
    );
  });

  it("asset download: begin is indeterminate, progress counts, downloaded records the path", () => {
    const begin = step(machine(), { t: "asset-download-begin" }).state;
    expect(begin).toMatchObject({ status: "downloading", progress: null });
    const progress = step(machine(), { t: "asset-download-progress", percent: 55 }).state;
    expect(progress).toMatchObject({ status: "downloading", progress: 55 });
    const done = step(machine(), { t: "asset-downloaded", path: "/tmp/omp-ui.deb" }).state;
    expect(done).toMatchObject({ status: "downloaded", downloadedPath: "/tmp/omp-ui.deb" });
    expect(done.progress).toBeNull();
  });

  it("asset-download-failed keeps the last progress — deliberate retention", () => {
    const prev = machine({ state: { ...IDLE_STATE, status: "downloading", progress: 88 } });
    const { state } = step(prev, { t: "asset-download-failed", message: "checksum mismatch" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("checksum mismatch");
    expect(state.progress).toBe(88);
  });

  it("dismiss clears the offer but keeps currentVersion, format, and installOnQuit", () => {
    const prev = machine({
      state: {
        ...IDLE_STATE,
        status: "available",
        latestVersion: "1.2.0",
        releaseUrl: RELEASE.url,
        releaseName: RELEASE.name,
        downloadedPath: "/tmp/old.deb",
        installOnQuit: true,
        error: "stale",
      },
      release: RELEASE,
    });
    const next = step(prev, { t: "dismiss" });
    expect(next.state).toEqual({ ...IDLE_STATE, installOnQuit: true });
    expect(next.release).toBeNull();
  });

  it("dismissed mid-staging is reachable as {release: null, stage: {visible: true}}", () => {
    const staging = step(machine(), {
      t: "stage-enter",
      visible: true,
      release: RELEASE,
      format: "appimage",
    });
    const dismissed = step(staging, { t: "dismiss" });
    expect(dismissed).toMatchObject({ release: null, stage: { visible: true } });
    expect(dismissed.state.status).toBe("idle");
    // The in-flight stage keeps running: a later completion re-surfaces the card.
    const completed = step(dismissed, { t: "stage-complete", version: "1.2.0" });
    expect(completed.state.status).toBe("downloaded");
    expect(completed.stage).toBeNull();
  });

  it("every event returns a complete state snapshot", () => {
    const events: AppUpdateEvent[] = [
      { t: "disabled" },
      { t: "check-begin" },
      { t: "unreachable", manual: true },
      { t: "unreachable", manual: false },
      { t: "up-to-date", manual: true },
      { t: "up-to-date", manual: false },
      { t: "offer-dismissed" },
      { t: "available", release: RELEASE, format: "rpm" },
      { t: "stage-enter", visible: true, release: RELEASE, format: "appimage" },
      { t: "stage-progress", percent: 1 },
      { t: "stage-complete", version: "1.2.0" },
      { t: "stage-empty", visible: true },
      { t: "stage-failed", visible: true, message: "m" },
      { t: "installing" },
      { t: "apply-failed", message: "m" },
      { t: "install-on-quit", on: true },
      { t: "asset-missing" },
      { t: "checksums-missing" },
      { t: "asset-download-begin" },
      { t: "asset-download-progress", percent: 50 },
      { t: "asset-download-failed", message: "m" },
      { t: "asset-downloaded", path: "/p" },
      { t: "dismiss" },
    ];
    for (const event of events) {
      const next = step(machine(), event);
      expect(Object.keys(next.state).sort()).toEqual(Object.keys(IDLE_STATE).sort());
    }
  });
});
