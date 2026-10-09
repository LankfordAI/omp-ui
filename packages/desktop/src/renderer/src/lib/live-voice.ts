import { IS_ELECTRON } from "./platform";
import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained live voice in 18.5.1 (issue #778). */
export const NATIVE_LIVE_MIN_OMP = "18.5.1";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeLive(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_LIVE_MIN_OMP) >= 0;
}

/**
 * Live audio is anchored to the session host's hardware (ADR-0049): the
 * call opens the host's mic and speakers, so only a client that *is* the
 * host — the Electron shell, on a locally owned tab — can participate
 * (issue #816). A remote web client's audio never reaches the call, and a
 * joined remote-instance tab would arm the *other* host's microphone.
 */
export function liveAudioLocalToClient(instanceId: string | null): boolean {
  return IS_ELECTRON && instanceId === null;
}
