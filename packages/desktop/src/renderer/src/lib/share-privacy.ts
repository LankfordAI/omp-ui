// First-share privacy confirmation, per install (issue #679).
// Like lib/text-scale.ts: a view fact outside the store, localStorage so it
// survives a restart; every access guarded — storage can throw in private mode.
const KEY = "omp-ui.sharePrivacySeen";

export function hasSeenSharePrivacy(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false; // No storage: the dialog re-asks. Never skip it silently.
  }
}

export function markSharePrivacySeen(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Persistence is best-effort; the in-session gate already fired.
  }
}
