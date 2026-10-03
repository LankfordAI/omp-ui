/**
 * Event-filter negotiation (issue #718): `set_event_filter` with
 * `messageUpdates: "delta"` asks the runtime to strip the accumulated message
 * snapshot from `message_update` frames, keeping only the delta fields. A long
 * streaming turn re-ships the whole message once per flush in full mode —
 * quadratic bytes per turn — which is the dominant per-frame IPC cost of the
 * native transcript with several live tabs.
 *
 * Verified against the managed binary (18.4.12, `strings`): the handler
 * requires `events` to be `null` or an array of event-type strings — the
 * command MUST pass `events: null` explicitly; omitting it errors.
 * `messageUpdates` defaults to `"full"`; values other than `"full"`/`"delta"`
 * error. The response echoes the active mode as `{ events, messageUpdates }`.
 * Older runtimes answer with `success: false` ("unknown command"), the
 * silent, complete fallback to full snapshots — the renderer adapts frame by
 * frame, so no mode flag ever crosses the IPC boundary.
 */

/** Fixed id so spawn tests can assert it and one response watcher can
 * correlate the echo (the host-bridge registration-command idiom). */
export const EVENT_FILTER_COMMAND_ID = "omp-ui-event-filter-1";

/**
 * The filter command, riding `initialCommands` exactly once per process —
 * fresh spawn and hibernate-resume alike, with the ADR-0043 registration
 * guarantee the host commands also rely on.
 */
export function setEventFilterCommand(id = EVENT_FILTER_COMMAND_ID): object {
  return { id, type: "set_event_filter", events: null, messageUpdates: "delta" };
}

/**
 * True only when the `set_event_filter` response data echoes delta mode.
 * Tolerant like every frame parser here: values which are not objects, or
 * whose `messageUpdates` field is missing or odd, read as "not delta" —
 * full mode echoed back is the documented default, not delta.
 */
export function eventFilterEchoIsDelta(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === "object" &&
    (data as Record<string, unknown>).messageUpdates === "delta"
  );
}
