import type { BackendState } from "@omp-ui/core/types";

/**
 * The title a tab is labelled with in the chrome (issue #416): a session owned
 * by a joined remote instance carries that instance's nickname as a prefix, so
 * two "Fix the build" tabs from two hosts stay tellable apart. Local sessions
 * read exactly as before. Pure over `BackendState` — no store import — so the
 * title bar, the compact nav, and the HUD share one rule.
 */
export function tabTitle(state: BackendState | null, tabId: string): string | undefined {
  if (state === null) return undefined;
  for (const group of state.projects) {
    const record = group.sessions.find((s) => s.tabId === tabId);
    if (record !== undefined) return record.title;
  }
  for (const instance of state.remoteInstances) {
    for (const group of instance.projects) {
      const record = group.sessions.find((s) => s.tabId === tabId);
      if (record !== undefined) return `${instance.nickname} · ${record.title}`;
    }
  }
  return undefined;
}
