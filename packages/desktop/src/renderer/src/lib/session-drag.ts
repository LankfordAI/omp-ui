/**
 * The drag payload of a sidebar session row (issue #984): its tabId under an
 * omp-ui-private MIME type, so only a native composer accepts the drop and a
 * row dragged anywhere else carries no text to paste.
 */
export const SESSION_DRAG_MIME = "application/x-omp-ui-session";
