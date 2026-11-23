import type { RemoteInstanceStatus } from "@omp-ui/core/types";
import type { Tone } from "./tone";

/**
 * How a remote instance's connection status reads in the chrome (issue #416),
 * shared by the sidebar group header and the Settings page so both tell the
 * same story. Tones follow ADR-0004: the signal accent means "joined and
 * live"; a pulse only while a connection attempt is in flight; rose for every
 * state the user has to act on or wait out; `self` is quiet because nothing
 * is wrong with it — it is just this app.
 */
export function remoteInstanceStatusTone(status: RemoteInstanceStatus): Tone {
  switch (status) {
    case "joined":
      return "signal";
    case "unreachable":
    case "needs-sign-in":
    case "incompatible":
      return "rose";
    case "connecting":
    case "self":
      return "neutral";
  }
}

export function remoteInstanceStatusLabel(status: RemoteInstanceStatus): string {
  switch (status) {
    case "connecting":
      return "connecting";
    case "joined":
      return "joined";
    case "unreachable":
      return "unreachable";
    case "needs-sign-in":
      return "sign-in required";
    case "self":
      return "this app";
    case "incompatible":
      return "incompatible version";
  }
}
