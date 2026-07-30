export type ExtensionAction = { action: "dialog"; method: string } | { action: "auto-cancel" };

const DIALOG_METHODS = new Set(["select", "confirm", "input"]);

/**
 * extension_ui_request routing: select/confirm/input get native dialogs;
 * every other method (editor, notify, setStatus, setWidget, setTitle,
 * set_editor_text, open_url, cancel) is answered cancelled:true immediately —
 * a defined protocol response, not a no-op, because OMP blocks on the reply.
 */
export function routeExtensionRequest(request: unknown): ExtensionAction {
  const method =
    request !== null && typeof request === "object" && "method" in request
      ? request.method
      : undefined;
  if (typeof method === "string" && DIALOG_METHODS.has(method)) {
    return { action: "dialog", method };
  }
  return { action: "auto-cancel" };
}

export function extensionCancelResponse(id: unknown): Record<string, unknown> {
  return { type: "extension_ui_response", id, cancelled: true };
}
