import { compactionSettingsFromEntries } from "@omp-ui/core/compaction-threshold";
import type { StateCreator } from "zustand";
import { backend } from "../../backend";
import { applyTheme, currentThemeId, resolveTheme } from "../../lib/themes";
import { applyFontFamily, currentFontFamilyId, resolveFontFamily } from "../../lib/font-families";
import { applyLocale, currentLocaleId, resolveLocale } from "../../lib/i18n";
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

const DEFAULT_PROVIDER_OAUTH: SettingsSlice["providerOAuth"] = {
  providerId: null,
  phase: "idle",
  url: null,
  instructions: null,
  prompt: null,
  error: null,
};

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
export const createSettingsSlice: StateCreator<UiStore, [], [], SettingsSlice> = (set, get) => {
  /**
   * Remote-settings writes restart the server, which drops the socket a
   * REMOTE client is asking over. That client's own call cannot receive its
   * reply; reconnect is the successful outcome — the reconnect banner owns
   * that case. Every other rejection (the same message arriving on the
   * desktop window, or a policy error) is a real failure and lands in the
   * error notices (issue #373).
   */
  const reportRemoteError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "remote connection lost") return;
    get().reportError(message);
  };

  return {
    settingsPage: null,
    remote: DEFAULT_REMOTE,
    providerOAuth: DEFAULT_PROVIDER_OAUTH,
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
        get().reportError(err);
      }
    },

    async setDefaultAgentMode(mode) {
      try {
        await backend.setDefaultAgentMode(mode);
      } catch (err) {
        get().reportError(err);
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
        get().reportError(err);
      }
    },

    async setPlanFormat(format) {
      try {
        await backend.setPlanFormat(format);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setHibernateIdleMinutes(minutes) {
      try {
        await backend.setHibernateIdleMinutes(minutes);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setStreamStallAbortSeconds(seconds) {
      try {
        await backend.setStreamStallAbortSeconds(seconds);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setAdvisorAutoReply(on) {
      try {
        await backend.setAdvisorAutoReply(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setStallAutoContinue(on) {
      try {
        await backend.setStallAutoContinue(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setDesktopNotifications(on) {
      try {
        await backend.setDesktopNotifications(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setDefaultAdvisor(on) {
      try {
        await backend.setDefaultAdvisor(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setSkipDeleteConfirmation(skip) {
      try {
        await backend.setSkipDeleteConfirmation(skip);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setThemeId(id) {
      const previousId = currentThemeId();
      applyTheme(resolveTheme(id));
      try {
        await backend.setThemeId(id);
      } catch (err) {
        applyTheme(resolveTheme(previousId));
        get().reportError(err);
      }
    },

    async setFontFamilyId(id) {
      const previousId = currentFontFamilyId();
      applyFontFamily(resolveFontFamily(id));
      try {
        await backend.setFontFamilyId(id);
      } catch (err) {
        applyFontFamily(resolveFontFamily(previousId));
        get().reportError(err);
      }
    },

    async setLocaleId(id) {
      const previousId = currentLocaleId();
      applyLocale(resolveLocale(id));
      try {
        await backend.setLocaleId(id);
      } catch (err) {
        applyLocale(resolveLocale(previousId));
        get().reportError(err);
      }
    },

    async setAppUpdateCheckOnLaunch(on) {
      try {
        await backend.setAppUpdateCheckOnLaunch(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async setOmpUpdateCheckOnLaunch(on) {
      try {
        await backend.setOmpUpdateCheckOnLaunch(on);
      } catch (err) {
        get().reportError(err);
      }
    },

    async clearDismissedAppUpdate() {
      try {
        await backend.clearDismissedAppUpdate();
      } catch (err) {
        get().reportError(err);
      }
    },

    async clearDismissedOmpUpdate() {
      try {
        await backend.clearDismissedOmpUpdate();
      } catch (err) {
        get().reportError(err);
      }
    },

    async setRemoteEnabled(on) {
      try {
        await backend.setRemoteEnabled(on);
      } catch (err) {
        reportRemoteError(err);
      }
    },

    async setRemoteBind(bind) {
      try {
        await backend.setRemoteBind(bind);
      } catch (err) {
        reportRemoteError(err);
      }
    },

    async setRemotePort(port) {
      try {
        await backend.setRemotePort(port);
      } catch (err) {
        reportRemoteError(err);
      }
    },

    async regenerateRemoteToken() {
      try {
        await backend.regenerateRemoteToken();
      } catch (err) {
        reportRemoteError(err);
      }
    },

    async setRemotePassword(password) {
      try {
        await backend.setRemotePassword(password);
      } catch (err) {
        reportRemoteError(err);
      }
    },

    async clearRemotePassword() {
      try {
        await backend.clearRemotePassword();
      } catch (err) {
        reportRemoteError(err);
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

    replaceProviderOAuth(state) {
      const previous = get().providerOAuth.phase;
      set({ providerOAuth: state });
      // A finished sign-in adds new accounts to every live session's model
      // picker; a still-running session may need a restart to see them.
      if (state.phase === "done" && previous !== "done") {
        for (const tabId of Object.keys(get().rpc)) {
          void get().refreshAvailableModels(tabId);
        }
      }
    },

    readProviderOAuth() {
      return backend.readProviderOAuth();
    },

    startProviderOAuth(id) {
      return backend.startProviderOAuth(id);
    },

    submitProviderOAuthInput(value) {
      return backend.submitProviderOAuthInput(value);
    },

    cancelProviderOAuth() {
      return backend.cancelProviderOAuth();
    },

    signOutProviderOAuth(id) {
      return backend.signOutProviderOAuth(id);
    },
  };
};
