export type ExtensionAction =
  | { action: "dialog"; method: string }
  | { action: "open-url" }
  | { action: "auto-cancel" };

const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

/**
 * extension_ui_request routing: select/confirm/input/editor get native
 * dialogs — editor included because omp's ask tool delivers "Other (type your
 * own)" as an editor request; open_url (rpc login/OAuth flows) opens the
 * system browser and confirms; every other method (notify, setStatus,
 * setWidget, setTitle, set_editor_text, cancel) is answered cancelled:true
 * immediately — a defined protocol response, not a no-op, because OMP blocks
 * on the reply.
 */
export function routeExtensionRequest(request: unknown): ExtensionAction {
  const method =
    request !== null && typeof request === "object" && "method" in request
      ? request.method
      : undefined;
  if (typeof method === "string" && DIALOG_METHODS[method] === true) {
    return { action: "dialog", method };
  }
  if (method === "open_url") return { action: "open-url" };
  return { action: "auto-cancel" };
}

export function extensionCancelResponse(id: unknown): Record<string, unknown> {
  return { type: "extension_ui_response", id, cancelled: true };
}
