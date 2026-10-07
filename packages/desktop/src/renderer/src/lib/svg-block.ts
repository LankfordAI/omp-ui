/**
 * Data-URI source for a settled agent `svg` fence (issue #780), or null when
 * the text is not a well-formed SVG document — the caller then keeps the
 * code block. The string never enters the transcript DOM: it is an `img`
 * src, and Chromium's image-mode SVG loading runs no script, loads no
 * external resource, and fires no handler, so image mode is the sanitizer
 * (#285's posture: no new HTML insertion point). `currentColor` — inert
 * black inside an image — is rewritten to the active ink hex so diagrams
 * follow the theme the way mermaid output does.
 */
export function svgImageSrc(text: string, ink: string): string | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror") !== null) return null;
  const rewrite = (value: string): string => value.replace(/currentcolor/gi, ink);
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of el.attributes) {
      // Guard with `includes`, not a /g regex `test`: `test` advances
      // `lastIndex` on global regexes, and `rewrite` builds its matcher
      // fresh per call.
      if (attr.value.toLowerCase().includes("currentcolor")) {
        attr.value = rewrite(attr.value);
      }
    }
    if (el.nodeName === "style") {
      el.textContent = rewrite(el.textContent ?? "");
    }
  }
  // The round-trip, never the raw source text.
  const source = new XMLSerializer().serializeToString(root);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}
