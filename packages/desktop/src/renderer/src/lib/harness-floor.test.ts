import { describe, expect, it } from "vitest";
import { compareVersions } from "@omp-ui/core/semver";
import { MIN_SUPPORTED_OMP } from "@omp-ui/core/harness-floor";
import { ANONYMIZE_MIN_OMP } from "./anonymize";
import { ASK_AND_REMEMBER_MIN_OMP } from "./ask-and-remember";
import { BTW_INJECT_MIN_OMP } from "./btw-inject";
import { COMPUTER_CONTROL_POLICY_MIN_OMP } from "./computer-control";
import { NETWORK_EXPORT_VIEWER_MIN_OMP } from "./export-html";
import { NATIVE_LIVE_MIN_OMP } from "./live-voice";
import { NATIVE_BTW_MIN_OMP } from "./native-btw";
import { SESSION_MIGRATE_MIN_OMP } from "./session-migrate";
import { NATIVE_FORK_MIN_OMP } from "./session-fork";
import { NARRATION_MIN_OMP } from "./narration";
import { PROMOTE_QUEUED_MIN_OMP, RESTORE_QUEUE_MIN_OMP } from "./queue-chip";

// MIN_SUPPORTED_OMP must cover every shipped feature gate. A release that
// adds a gate above the current floor MUST bump the floor in the same change.
// (Core's own omp-update.test guards the core-side gates, same invariant.)
describe("MIN_SUPPORTED_OMP harness floor", () => {
  it.each([
    ["ANONYMIZE_MIN_OMP", ANONYMIZE_MIN_OMP],
    ["ASK_AND_REMEMBER_MIN_OMP", ASK_AND_REMEMBER_MIN_OMP],
    ["BTW_INJECT_MIN_OMP", BTW_INJECT_MIN_OMP],
    ["NATIVE_LIVE_MIN_OMP", NATIVE_LIVE_MIN_OMP],
    ["NATIVE_BTW_MIN_OMP", NATIVE_BTW_MIN_OMP],
    ["NATIVE_FORK_MIN_OMP", NATIVE_FORK_MIN_OMP],
    ["PROMOTE_QUEUED_MIN_OMP", PROMOTE_QUEUED_MIN_OMP],
    ["RESTORE_QUEUE_MIN_OMP", RESTORE_QUEUE_MIN_OMP],
    ["NARRATION_MIN_OMP", NARRATION_MIN_OMP],
    ["COMPUTER_CONTROL_POLICY_MIN_OMP", COMPUTER_CONTROL_POLICY_MIN_OMP],
    ["NETWORK_EXPORT_VIEWER_MIN_OMP", NETWORK_EXPORT_VIEWER_MIN_OMP],
    ["SESSION_MIGRATE_MIN_OMP", SESSION_MIGRATE_MIN_OMP],
  ] as const)("is at or above %s", (_name, gate) => {
    expect(compareVersions(MIN_SUPPORTED_OMP, gate)).toBeGreaterThanOrEqual(0);
  });
});
