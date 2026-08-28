/**
 * The user-answer dialogs routed to the renderer. One definition (issue: two
 * copies drifted toward divergence): select/confirm/input/editor get native
 * dialogs — editor included because omp's ask tool delivers "Other (type your
 * own)" as an editor request. Every other method (notify, setStatus, setWidget,
 * setTitle, set_editor_text, cancel) is fire-and-forget state the renderer
 * consumes without a reply — tracking it would suppress the hibernation and
 * stall guards forever.
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
