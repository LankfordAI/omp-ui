// The GPU-process notice (performance plan Phase 4): one dismissible slot fed
// by the main process when the GPU child disappears. Electron offers no
// supported way to restore that process in-run, so the notice states the
// observation and the honest remedy (relaunch), never a cause.
import type { StateCreator } from "zustand";
import type { UiStore } from "../types";

export type GpuSlice = Pick<
  UiStore,
  "gpuCrashDetail" | "noteGpuCrash" | "dismissGpuCrash"
>;

export const createGpuSlice: StateCreator<UiStore, [], [], GpuSlice> = (set, get) => ({
  gpuCrashDetail: null,

  noteGpuCrash(detail) {
    // Once per episode: repeated GPU deaths while the notice is up must not
    // stack cards or restart the entry's animation; dismiss resets the latch.
    if (get().gpuCrashDetail !== null) return;
    set({ gpuCrashDetail: detail });
  },

  dismissGpuCrash() {
    set({ gpuCrashDetail: null });
  },
});
