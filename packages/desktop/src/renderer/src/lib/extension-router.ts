import { isBlockingDialogMethod } from "@omp-ui/core/extension-dialog";

export type ExtensionAction =
  | { action: "dialog"; method: string }
  | { action: "open-url" }
  | { action: "auto-cancel" };

/**
 * extension_ui_request routing: the blocking-dialog methods (core's
 * BLOCKING_DIALOG_METHODS, shared with hibernation) get native dialogs;
 * open_url (rpc login/OAuth flows) opens the system browser and confirms;
 * every other method (notify, setStatus, setWidget, setTitle,
 * set_editor_text, cancel) is answered cancelled:true immediately — a defined
 * protocol response, not a no-op, because OMP blocks on the reply.
 */
export function routeExtensionRequest(request: unknown): ExtensionAction {
  const method =
    request !== null && typeof request === "object" && "method" in request
      ? request.method
      : undefined;
  if (isBlockingDialogMethod(method)) return { action: "dialog", method };
  if (method === "open_url") return { action: "open-url" };
  return { action: "auto-cancel" };
}

export function extensionCancelResponse(id: unknown): Record<string, unknown> {
  return { type: "extension_ui_response", id, cancelled: true };
}
