import { bareUrlAt } from "./markdown";

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

/** A dev server on this machine: HTTP(S) with a loopback or *.localhost host. */
export function isLocalDevUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTS[url.hostname] === true || url.hostname.endsWith(".localhost");
}

/** Distinct normalized local dev-server URLs from a tool result, in first-seen order. */
export function localDevUrls(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "h" && char !== "H") continue;
    const hit = bareUrlAt(text, i);
    if (hit === null) continue;
    i = hit.next - 1;
    if (!isLocalDevUrl(hit.href)) continue;
    const href = new URL(hit.href).href;
    if (!out.includes(href)) out.push(href);
  }
  return out;
}
