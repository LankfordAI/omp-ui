import { compareVersions } from "@omp-ui/core/semver";

/** omp's rpc-ui gained `live_connect` — live voice on a caller-owned WebRTC
 *  peer — in 18.14.0 (ADR-0071, issue #967). */
export const NATIVE_LIVE_MIN_OMP = "18.14.0";

/** Unknown version hides the feature: an older runtime rejects the verbs. */
export function supportsNativeLive(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, NATIVE_LIVE_MIN_OMP) >= 0;
}

/** omp 18.21.0 switched local TTS to Phonon and narrowed the accepted
 *  speaking-rate band to 0.8–1.3 (upstream `tts/models.ts` PHONON_SPEED_CURVE,
 *  issue #1198). Older omp clamps at 0.5–2.5. */
export const PHONON_SPEED_MIN_OMP = "18.21.0";

/** The speech-rate band the installed omp stores without silently rewriting:
 *  0.8–1.3 on omp ≥ 18.21.0, 0.5–2.5 below it. An unknown version keeps the
 *  wide band — the pre-Phonon clamp, which an older binary actually honors. */
export function speechSpeedBand(ompVersion: string | null): { min: number; max: number } {
  return ompVersion !== null && compareVersions(ompVersion, PHONON_SPEED_MIN_OMP) >= 0
    ? { min: 0.8, max: 1.3 }
    : { min: 0.5, max: 2.5 };
}
