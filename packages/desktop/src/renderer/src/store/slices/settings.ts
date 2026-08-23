import { compactionSettingsFromEntries } from "@omp-ui/core/compaction-threshold";
import type { StateCreator } from "zustand";
import { backend } from "../../backend";
import { applyTheme, currentThemeId, resolveTheme } from "../../lib/themes";
import type { SettingsSlice, UiStore } from "../types";

const DEFAULT_REMOTE: SettingsSlice["remote"] = {
  status: "stopped",
  enabled: false,
  bind: "localhost",
  port: 4677,
  token: "",
  hasPassword: false,
  urls: [],
  tokenUrls: [],
  webBundleMissing: false,
  error: null,
};

function alertError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

/**
 * Remote-settings writes restart the server, which drops the socket a REMOTE client is asking
 * over. That client's own call cannot receive its reply; reconnect is the successful outcome.
 */
function alertRemoteError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "remote connection lost") return;
  window.alert(message);
}

/**
 * Dedupes in-flight compaction settings reads per project. Lives outside the
 * store state (which stays data-only); the cache itself is store state.
 */
const compactionInflight = new Map<string, Promise<void>>();
/**
 * Bumped on every compaction.* write; a snapshot read before the write must
 * not land over the cleared cache (the notch would show a stale threshold).
 */
let compactionGeneration = 0;
let compactionMethodsInflight: Promise<void> | null = null;
export const createSettingsSlice: StateCreator<UiStore, [], [], SettingsSlice> = (set, get) => ({
  settingsPage: null,
  remote: DEFAULT_REMOTE,
  compactionSettings: {},
  compactionMethods: { status: "unloaded" },

  openSettings(page) {
    set({ settingsPage: page ?? "general" });
  },

  closeSettings() {
    set({ settingsPage: null });
  },

  replaceRemote(remote) {
    set({ remote });
  },

  async setDefaultMode(mode) {
    try {
      await backend.setDefaultMode(mode);
    } catch (err) {
      alertError(err);
    }
  },

  async setDefaultAgentMode(mode) {
    try {
      await backend.setDefaultAgentMode(mode);
    } catch (err) {
      alertError(err);
    }
  },

  async ensureCompactionMethods() {
    if (get().compactionMethods.status === "loaded") return;
    if (compactionMethodsInflight !== null) return compactionMethodsInflight;
    set({ compactionMethods: { status: "loading" } });
    compactionMethodsInflight = (async () => {
      try {
        const methods = await backend.listCompactionMethods();
        set({ compactionMethods: { status: "loaded", methods } });
      } catch (err) {
        set({
          compactionMethods: {
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
    try {
      await compactionMethodsInflight;
    } finally {
      compactionMethodsInflight = null;
    }
  },

  async setDefaultCompactionMethod(method) {
    try {
      await backend.setDefaultCompactionMethod(method);
    } catch (err) {
      alertError(err);
    }
  },

  async setPlanFormat(format) {
    try {
      await backend.setPlanFormat(format);
    } catch (err) {
      alertError(err);
    }
  },

  async setHibernateIdleMinutes(minutes) {
    try {
      await backend.setHibernateIdleMinutes(minutes);
    } catch (err) {
      alertError(err);
    }
  },

  async setStreamStallAbortSeconds(seconds) {
    try {
      await backend.setStreamStallAbortSeconds(seconds);
    } catch (err) {
      alertError(err);
    }
  },

  async setAdvisorAutoReply(on) {
    try {
      await backend.setAdvisorAutoReply(on);
    } catch (err) {
      alertError(err);
    }
  },

  async setStallAutoContinue(on) {
    try {
      await backend.setStallAutoContinue(on);
    } catch (err) {
      alertError(err);
    }
  },

  async setDefaultAdvisor(on) {
    try {
      await backend.setDefaultAdvisor(on);
    } catch (err) {
      alertError(err);
    }
  },

  async setSkipDeleteConfirmation(skip) {
    try {
      await backend.setSkipDeleteConfirmation(skip);
    } catch (err) {
      alertError(err);
    }
  },

  async setThemeId(id) {
    const previousId = currentThemeId();
    applyTheme(resolveTheme(id));
    try {
      await backend.setThemeId(id);
    } catch (err) {
      applyTheme(resolveTheme(previousId));
      alertError(err);
    }
  },

  async setAppUpdateCheckOnLaunch(on) {
    try {
      await backend.setAppUpdateCheckOnLaunch(on);
    } catch (err) {
      alertError(err);
    }
  },

  async setOmpUpdateCheckOnLaunch(on) {
    try {
      await backend.setOmpUpdateCheckOnLaunch(on);
    } catch (err) {
      alertError(err);
    }
  },

  async clearDismissedAppUpdate() {
    try {
      await backend.clearDismissedAppUpdate();
    } catch (err) {
      alertError(err);
    }
  },

  async clearDismissedOmpUpdate() {
    try {
      await backend.clearDismissedOmpUpdate();
    } catch (err) {
      alertError(err);
    }
  },

  async setRemoteEnabled(on) {
    try {
      await backend.setRemoteEnabled(on);
    } catch (err) {
      alertRemoteError(err);
    }
  },

  async setRemoteBind(bind) {
    try {
      await backend.setRemoteBind(bind);
    } catch (err) {
      alertRemoteError(err);
    }
  },

  async setRemotePort(port) {
    try {
      await backend.setRemotePort(port);
    } catch (err) {
      alertRemoteError(err);
    }
  },

  async regenerateRemoteToken() {
    try {
      await backend.regenerateRemoteToken();
    } catch (err) {
      alertRemoteError(err);
    }
  },

  async setRemotePassword(password) {
    try {
      await backend.setRemotePassword(password);
    } catch (err) {
      alertRemoteError(err);
    }
  },

  async clearRemotePassword() {
    try {
      await backend.clearRemotePassword();
    } catch (err) {
      alertRemoteError(err);
    }
  },

  readOmpSettings(projectCwd) {
    return backend.readOmpSettings(projectCwd);
  },

  async ensureCompactionSettings(projectCwd) {
    // Cache hit (a failed read lands null, which is also cached): the value
    // is valid until a compaction.* write clears it or the app relaunches.
    if (projectCwd in get().compactionSettings) return;
    const existing = compactionInflight.get(projectCwd);
    if (existing) return existing;
    const generation = compactionGeneration;
    const fetch = (async () => {
      try {
        // Never rejects for missing keys — snapshot.error carries omp failures
        // (same contract Settings.tsx relies on when it reads the page).
        const snapshot = await backend.readOmpSettings(projectCwd);
        const value = snapshot.error === null
          ? compactionSettingsFromEntries(snapshot.entries)
          : null;
        // A compaction.* write bumped the generation and cleared the cache:
        // this pre-write snapshot is stale and must not re-land; the next
        // ensure refetches.
        set((s) =>
          generation !== compactionGeneration || projectCwd in s.compactionSettings
            ? s
            : { compactionSettings: { ...s.compactionSettings, [projectCwd]: value } },
        );
      } catch {
        // IPC hop failure: leave the key absent; the next HUD mount retries.
      }
    })();
    compactionInflight.set(projectCwd, fetch);
    try {
      await fetch;
    } finally {
      compactionInflight.delete(projectCwd);
    }
  },

  writeOmpSetting(key, value) {
    return backend.writeOmpSetting(key, value).then(() => {
      // Writes target omp's GLOBAL layer, so every project's effective values
      // may change — clear the whole cache; the next HUD use refetches.
      if (key.startsWith("compaction.")) {
        compactionGeneration += 1;
        set({ compactionSettings: {} });
      }
    });
  },

  readProviderKeys(projectCwd) {
    return backend.readProviderKeys(projectCwd);
  },

  setProviderKey(envName, value) {
    return backend.setProviderKey(envName, value);
  },

  clearProviderKey(envName) {
    return backend.clearProviderKey(envName);
  },
});
