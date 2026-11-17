/**
 * The user-answer dialogs routed to the renderer. One definition (issue: two
 * copies drifted toward divergence): select/confirm/input/editor get native
 * dialogs — editor included because omp's ask tool delivers "Other (type your
 * own)" as an editor request. Every other method (notify, setStatus, setWidget,
 * setTitle, set_editor_text) is fire-and-forget state the renderer
 * consumes without a reply — tracking it would suppress the hibernation and
 * stall guards forever. `cancel` is not state either: it names a dialog omp
 * has already settled on its own (see `parseExtensionDialogCancel`), so it
 * removes tracked state rather than joining it.
 */
export const BLOCKING_DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
};

/** Narrows an `unknown` frame method without stringifying the value. */
export function isBlockingDialogMethod(method: unknown): method is string {
  return typeof method === "string" && BLOCKING_DIALOG_METHODS[method] === true;
}

/**
 * The dialog id omp has already settled and wants the host to stop showing
 * (issue #1191): when a dialog's abort signal fires or its timeout elapses,
 * omp sends `extension_ui_request { method: "cancel", targetId }` under a
 * fresh frame id — its own pending request is gone, so the cancel frame must
 * never be answered. The host closes the dialog whose id is `targetId`; a
 * cancel for an unknown id is a silent no-op. Null for any other frame, and
 * for a cancel that names no usable target.
 */
export function parseExtensionDialogCancel(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  if (record.type !== "extension_ui_request" || record.method !== "cancel") return null;
  return typeof record.targetId === "string" ? record.targetId : null;
}
