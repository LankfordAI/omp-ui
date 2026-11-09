import { describe, expect, it } from "vitest";
import {
  composeHtmlArtifactDocument,
  HTML_ARTIFACT_CSP,
  HTML_ARTIFACT_DEFAULT_HEIGHT,
  HTML_ARTIFACT_MAX_BYTES,
  HTML_ARTIFACT_MAX_HEIGHT,
  HEIGHT_HASH_PREFIX,
  HTML_ARTIFACT_MIN_HEIGHT,
  HTML_ARTIFACT_STATIC_CSP,
  htmlArtifactDataUrl,
  isHtmlArtifactRequestAllowed,
  parseHtmlArtifactArgs,
} from "./html-artifact";

function fileArtifact(valueFile: unknown = "local://datasets/rows.json") {
  return { protocolVersion: 1, stateSchema: "view-v1", initialState: {}, datasets: [{ id: "rows", title: "Rows", schema: "rows-v1", valueFile, provenance: { source: { kind: "file", label: "Rows", locator: "local://datasets/rows.json" }, method: { kind: "import", description: "Read rows" }, refresh: { kind: "manual", requiredSources: ["local://datasets/rows.json"] } } }] };
}

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

  it("accepts unresolved file-backed datasets without materializing placeholder values", () => {
    const artifact = fileArtifact();
    expect(parseHtmlArtifactArgs({ title: "Chart", html: "<p>x</p>", artifact })).toEqual({ ok: true, args: { title: "Chart", html: "<p>x</p>", height: HTML_ARTIFACT_DEFAULT_HEIGHT, artifact } });
    expect(artifact.datasets[0]).not.toHaveProperty("value");
  });

  it("refuses invalid file paths and datasets with both value sources", () => {
    expect(parseHtmlArtifactArgs({ title: "Chart", html: "x", artifact: fileArtifact("local://../rows.json") }).ok).toBe(false);
    const artifact = fileArtifact();
    const withBoth = { ...artifact, datasets: [{ ...artifact.datasets[0]!, value: null }] };
    expect(parseHtmlArtifactArgs({ title: "Chart", html: "x", artifact: withBoth }).ok).toBe(false);
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

  it("stubs the height reporter and margin reset ahead of authored markup when scripts run", () => {
    const authored = "<script>run()</script>";
    const doc = composeHtmlArtifactDocument(authored, ":root{}", true);
    expect(doc).toContain("body{margin:0}");
    expect(doc).toContain(HEIGHT_HASH_PREFIX);
    expect(doc).toContain("ResizeObserver");
    for (const needle of ["body{margin:0}", HEIGHT_HASH_PREFIX, "ResizeObserver"]) {
      expect(doc.indexOf(needle)).toBeGreaterThan(0);
      expect(doc.indexOf(needle)).toBeLessThan(doc.indexOf(authored));
    }
  });

  it("stamps neither the height stub nor the margin reset into a static document", () => {
    const doc = composeHtmlArtifactDocument("<p>x</p>", ":root{}", false);
    expect(doc).not.toContain("body{margin:0}");
    expect(doc).not.toContain(HEIGHT_HASH_PREFIX);
    expect(doc).not.toContain("ResizeObserver");
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
