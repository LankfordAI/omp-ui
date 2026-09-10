import type { StateCreator } from "zustand";
import { backend } from "../../backend";
import { desktop } from "../../desktop";
import type { UiStore, UpdatesSlice } from "../types";

const DEFAULT_APP_UPDATE: UpdatesSlice["appUpdate"] = {
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  format: "unknown",
  progress: null,
  downloadedPath: null,
  installOnQuit: false,
  error: null,
};

const DEFAULT_OMP_UPDATE: UpdatesSlice["ompUpdate"] = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

export const createUpdatesSlice: StateCreator<UiStore, [], [], UpdatesSlice> = (set) => ({
  appUpdate: DEFAULT_APP_UPDATE,
  ompUpdate: DEFAULT_OMP_UPDATE,

  replaceAppUpdate(appUpdate) {
    set({ appUpdate });
  },

  replaceOmpUpdate(ompUpdate) {
    set({ ompUpdate });
  },

  async checkOmpUpdate() {
    await backend.checkOmpUpdate();
  },

  async downloadOmpUpdate() {
    await backend.downloadOmpUpdate();
  },

  async dismissOmpUpdate(version, remember) {
    await backend.dismissOmpUpdate(version, remember);
  },

  async checkAppUpdate() {
    await desktop?.checkAppUpdate();
  },

  async downloadAppUpdate() {
    await desktop?.downloadAppUpdate();
  },

  async openAppUpdateReleaseNotes() {
    await desktop?.openAppUpdateReleaseNotes();
  },

  async showAppUpdateDownload() {
    await desktop?.showAppUpdateDownload();
  },

  async restartForAppUpdate() {
    await desktop?.restartForAppUpdate();
  },

  async setAppUpdateInstallOnQuit(on) {
    await desktop?.setAppUpdateInstallOnQuit(on);
  },

  async dismissAppUpdate(version, remember) {
    await desktop?.dismissAppUpdate(version, remember);
  },
});
