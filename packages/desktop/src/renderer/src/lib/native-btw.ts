import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained btw/btw_cancel/get_btw_history in 18.6.3 (upstream #14110). */
export const NATIVE_BTW_MIN_OMP = "18.6.3";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeBtw(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_BTW_MIN_OMP) >= 0;
}

/**
 * A draft's `?` sigil (issue #1233): upstream v19's `parseBtwShortcutInput`
 * (modes/controllers/input-controller.ts) is exactly `text.trimStart()` then
 * `startsWith("?")`, returning the remainder trimmed — so any leading `?`
 * claims the draft, whitespace or not, and a bare `?` yields the empty
 * question. omp turns an accepted shortcut into `/btw <question>` at submit
 * (a falsy question — bare `?` — falls through as ordinary text); we keep the
 * question separate so the refusal paths never see the sigil. This is the
 * composer's DRAFT-state rule: it flips on while typing, before any gate.
 */
export function parseBtwShortcut(text: string): string | null {
  const trimmed = text.trimStart();
  return trimmed.startsWith("?") ? trimmed.slice(1).trim() : null;
}

/**
 * Whether a `?` draft composes as a side question here (issue #1233): only a
 * native tab whose omp speaks the native `btw` verb — the route below the
 * floor refuses, and today's behavior (send the text verbatim) is what an
 * old harness must keep. Deliberately stricter than upstream, which rewrites
 * every draft regardless of route availability: here a rewritten line would
 * reach the model as literal `/btw` text on an unsupported harness.
 */
export function btwShortcutAvailable(nativeTab: boolean, ompVersion: string | null): boolean {
  return nativeTab && supportsNativeBtw(ompVersion);
}
