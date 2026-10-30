/**
 * The drag payload of a sidebar session row (issue #984): its tabId under an
 * omp-ui-private MIME type, so only a native composer accepts the drop and a
 * row dragged anywhere else carries no text to paste.
 */
export const SESSION_DRAG_MIME = "application/x-omp-ui-session";

/**
 * The one drag operation a session row offers and a composer accepts. It must
 * be "copy": Chromium on Wayland routes even an in-window drag through
 * wl_data_device, which has no link action, so it sends "link" as "copy" and
 * the page sees effectAllowed "copy". A composer asking for "link" then gets
 * no drop event at all. Source and target must name the same value.
 */
export const SESSION_DRAG_EFFECT = "copy";
