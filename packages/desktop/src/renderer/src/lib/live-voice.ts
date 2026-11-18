import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained `live_connect` — live voice on a caller-owned WebRTC
 *  peer — in 18.14.0 (ADR-0071, issue #967). */
export const NATIVE_LIVE_MIN_OMP = "18.14.0";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeLive(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_LIVE_MIN_OMP) >= 0;
}

/** omp's Phonon TTS speaking-rate band (upstream tts/models.ts PHONON_SPEED_CURVE, #1198). */
export const SPEECH_SPEED_BAND = { min: 0.8, max: 1.3 } as const;
