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

export const createSettingsSlice: StateCreator<UiStore, [], [], SettingsSlice> = (set) => ({
  settingsPage: null,
  remote: DEFAULT_REMOTE,

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

  writeOmpSetting(key, value) {
    return backend.writeOmpSetting(key, value);
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
