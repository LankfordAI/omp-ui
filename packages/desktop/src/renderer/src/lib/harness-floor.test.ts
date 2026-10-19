import { describe, expect, it } from "vitest";
import { compareVersions } from "@omp-ui/core/semver";
import { MIN_SUPPORTED_OMP } from "@omp-ui/core/harness-floor";
import { ANONYMIZE_MIN_OMP } from "./anonymize";
import { NATIVE_LIVE_MIN_OMP } from "./live-voice";
import { NATIVE_BTW_MIN_OMP } from "./native-btw";
import { NATIVE_FORK_MIN_OMP } from "./session-fork";
import { NARRATION_MIN_OMP } from "./narration";
import { PLAN_TIERS_MIN_OMP } from "./plan-tiers";
import { SEANCE_MIN_OMP } from "./seance";
import { PROMOTE_QUEUED_MIN_OMP, RESTORE_QUEUE_MIN_OMP } from "./queue-chip";

// The §1 invariant: MIN_SUPPORTED_OMP is the maximum of every shipped feature
// gate. A release that adds a gate above the current floor MUST bump the
// floor in the same change — this test is what catches it if someone forgets.
// (Core's own omp-update.test guards LOGOUT_ACCOUNTS_MIN_OMP, core-side.)
describe("MIN_SUPPORTED_OMP harness floor", () => {
  it.each([
    ["ANONYMIZE_MIN_OMP", ANONYMIZE_MIN_OMP],
    ["NATIVE_LIVE_MIN_OMP", NATIVE_LIVE_MIN_OMP],
    ["NATIVE_BTW_MIN_OMP", NATIVE_BTW_MIN_OMP],
    ["NATIVE_FORK_MIN_OMP", NATIVE_FORK_MIN_OMP],
    ["PROMOTE_QUEUED_MIN_OMP", PROMOTE_QUEUED_MIN_OMP],
    ["RESTORE_QUEUE_MIN_OMP", RESTORE_QUEUE_MIN_OMP],
    ["SEANCE_MIN_OMP", SEANCE_MIN_OMP],
    ["NARRATION_MIN_OMP", NARRATION_MIN_OMP],
    ["PLAN_TIERS_MIN_OMP", PLAN_TIERS_MIN_OMP],
  ] as const)("is at or above %s", (_name, gate) => {
    expect(compareVersions(MIN_SUPPORTED_OMP, gate)).toBeGreaterThanOrEqual(0);
  });
});
