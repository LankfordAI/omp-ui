import { describe, expect, it } from "vitest";
import {
  composeHtmlArtifactDocument,
  HTML_ARTIFACT_CSP,
  HTML_ARTIFACT_DEFAULT_HEIGHT,
  HTML_ARTIFACT_MAX_BYTES,
  HTML_ARTIFACT_MAX_HEIGHT,
  HTML_ARTIFACT_MIN_HEIGHT,
  HTML_ARTIFACT_STATIC_CSP,
  htmlArtifactDataUrl,
  isHtmlArtifactRequestAllowed,
  parseHtmlArtifactArgs,
} from "./html-artifact";

describe("parseHtmlArtifactArgs", () => {
  it("accepts a titled document and clamps the height into bounds", () => {
    expect(parseHtmlArtifactArgs({ title: "  Chart ", html: "<p>x</p>" })).toEqual({
      ok: true,
      args: { title: "Chart", html: "<p>x</p>", height: HTML_ARTIFACT_DEFAULT_HEIGHT },
    });
    const short = parseHtmlArtifactArgs({ title: "t", html: "x", height: 10 });
    expect(short.ok && short.args.height).toBe(HTML_ARTIFACT_MIN_HEIGHT);
    const tall = parseHtmlArtifactArgs({ title: "t", html: "x", height: 99_999 });
    expect(tall.ok && tall.args.height).toBe(HTML_ARTIFACT_MAX_HEIGHT);
  });

  it.each([
    [null, "arguments must be an object"],
    [{ html: "<p>x</p>" }, "title must be a non-empty string"],
    [{ title: "t", html: "   " }, "html must be a non-empty string"],
    [{ title: "x".repeat(201), html: "x" }, "title is longer than 200 characters"],
  ])("refuses %j", (raw, reason) => {
    const parsed = parseHtmlArtifactArgs(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(reason);
  });

  it("measures the byte budget in UTF-8, not UTF-16 units", () => {
    // 3 bytes per character: under the budget in characters, over it in bytes.
    const html = "€".repeat(Math.floor(HTML_ARTIFACT_MAX_BYTES / 3) + 1);
    expect(html.length).toBeLessThan(HTML_ARTIFACT_MAX_BYTES);
    const parsed = parseHtmlArtifactArgs({ title: "t", html });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain(`limit is ${HTML_ARTIFACT_MAX_BYTES} bytes`);
    expect(parseHtmlArtifactArgs({ title: "t", html: "a".repeat(HTML_ARTIFACT_MAX_BYTES) }).ok).toBe(true);
  });
});

describe("composeHtmlArtifactDocument", () => {
  it("puts the policy ahead of every authored byte, for fragments and full documents", () => {
    for (const authored of ["<script>run()</script>", "<!doctype html><html><head><script>run()</script></head></html>"]) {
      const doc = composeHtmlArtifactDocument(authored, ":root{}", true);
      const policyAt = doc.indexOf(`content="${HTML_ARTIFACT_CSP}"`);
      expect(policyAt).toBeGreaterThan(0);
      expect(policyAt).toBeLessThan(doc.indexOf(authored));
      expect(doc.endsWith(authored)).toBe(true);
    }
  });

  it("forbids every script when scripts are off, and never grants network", () => {
    const doc = composeHtmlArtifactDocument("<p>x</p>", "", false);
    expect(doc).toContain(`content="${HTML_ARTIFACT_STATIC_CSP}"`);
    expect(HTML_ARTIFACT_STATIC_CSP).toContain("script-src 'none'");
    for (const csp of [HTML_ARTIFACT_CSP, HTML_ARTIFACT_STATIC_CSP]) {
      expect(csp).toMatch(/^default-src 'none';/);
      expect(csp).not.toMatch(/connect-src|https?:|\*/);
    }
  });
});

describe("htmlArtifactDataUrl", () => {
  it("round-trips non-ASCII documents through base64", () => {
    const doc = "<p>Größe — 日本 €</p>";
    const url = htmlArtifactDataUrl(doc);
    expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(doc);
  });
});

describe("isHtmlArtifactRequestAllowed", () => {
  it.each([
    ["data:text/html;base64,AAAA", true],
    ["blob:null/1234", true],
    ["about:blank", true],
    ["https://example.com/x.png", false],
    ["http://127.0.0.1:9/", false],
    ["ws://127.0.0.1/", false],
    ["file:///etc/passwd", false],
    ["devtools://devtools/x", false],
  ])("%s → %s", (url, allowed) => {
    expect(isHtmlArtifactRequestAllowed(url)).toBe(allowed);
  });
});
