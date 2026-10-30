import { IS_ELECTRON } from "./platform";
import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained `live_connect` — live voice on a caller-owned WebRTC
 *  peer — in 18.14.0 (ADR-0071, issue #967). */
export const NATIVE_LIVE_MIN_OMP = "18.14.0";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeLive(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_LIVE_MIN_OMP) >= 0;
}

/**
 * Live audio is anchored to the session host's hardware (ADR-0049): the
 * renderer's peer opens this machine's mic and speakers, so only a client
 * that *is* the
 * host — the Electron shell, on a locally owned tab — can participate
 * (issue #816). A remote web client's audio never reaches the call, and a
 * joined remote-instance tab would arm the *other* host's microphone.
 */
export function liveAudioLocalToClient(instanceId: string | null): boolean {
  return IS_ELECTRON && instanceId === null;
}
