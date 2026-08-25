/**
 * Copies `text` without the async Clipboard API, which is secure-context-only and therefore
 * absent over `http://<lan-ip>` — the origin remote clients use (issue #37). The detached
 * textarea + execCommand route is deprecated but universally available, and is the only thing
 * that works there.
 */
export function copyFallback(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  // Off-screen rather than hidden: execCommand("copy") ignores a display:none selection.
  el.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
  document.body.append(el);
  try {
    el.select();
    el.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    el.remove();
  }
}
