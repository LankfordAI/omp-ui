import { describe, expect, it } from "vitest";
import {
  BROWSER_PANE_COMMAND,
  BROWSER_PANE_FRAME_HEADER_BYTES,
  browserPaneCssSize,
  browserPaneInstruction,
  browserPaneSetMessage,
  decodeBrowserPaneFrame,
  encodeBrowserPaneFrameHeader,
  isAllowedBrowserPaneSubframeUrl,
  isAllowedBrowserPaneTopLevelUrl,
  parseBrowserPaneSetArgs,
  type BrowserPaneFrameHeader,
} from "./browser-pane";

const TOKEN = "A".repeat(43);
const ENDPOINT = `http://127.0.0.1:4242/${TOKEN}`;

/** A wire frame: encoded header followed by the given payload bytes. */
function frame(header: BrowserPaneFrameHeader, payload: number[]): Uint8Array {
  const out = new Uint8Array(BROWSER_PANE_FRAME_HEADER_BYTES + payload.length);
  out.set(encodeBrowserPaneFrameHeader(header), 0);
  out.set(payload, BROWSER_PANE_FRAME_HEADER_BYTES);
  return out;
}

describe("frame header codec", () => {
  it.each([1, 1.25, 1.5, 2])("round-trips a %s dsf header", (dsf) => {
    const header = { width: 1280, height: 800, dsf };
    const decoded = decodeBrowserPaneFrame(frame(header, [0xff, 0xd8]));
    expect(decoded?.header).toEqual(header);
  });

  it("hands back the JPEG as a view over the input, not a copy", () => {
    const bytes = frame({ width: 4, height: 2, dsf: 1 }, [0xff, 0xd8, 0xff, 0xd9]);
    const decoded = decodeBrowserPaneFrame(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.jpeg.buffer).toBe(bytes.buffer);
    expect(decoded!.jpeg.byteOffset).toBe(BROWSER_PANE_FRAME_HEADER_BYTES);
    expect(Array.from(decoded!.jpeg)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it("maps physical pixels back to CSS px through the dsf", () => {
    expect(browserPaneCssSize({ width: 2560, height: 1600, dsf: 2 })).toEqual({ width: 1280, height: 800 });
    expect(browserPaneCssSize({ width: 1600, height: 1000, dsf: 1.25 })).toEqual({ width: 1280, height: 800 });
  });

  it("rejects a frame shorter than the header, a zero dimension, or a dsf under 0.5", () => {
    expect(decodeBrowserPaneFrame(new Uint8Array(BROWSER_PANE_FRAME_HEADER_BYTES - 1))).toBeNull();
    expect(decodeBrowserPaneFrame(frame({ width: 0, height: 800, dsf: 1 }, [1]))).toBeNull();
    expect(decodeBrowserPaneFrame(frame({ width: 1280, height: 0, dsf: 1 }, [1]))).toBeNull();
    expect(decodeBrowserPaneFrame(frame({ width: 1280, height: 800, dsf: 0.49 }, [1]))).toBeNull();
    expect(decodeBrowserPaneFrame(frame({ width: 1280, height: 800, dsf: 0.5 }, [1]))).not.toBeNull();
  });
});

describe("set payload parsing", () => {
  it("accepts exactly { cdpUrl } naming a loopback port with a 43-char base64url token path", () => {
    expect(parseBrowserPaneSetArgs(JSON.stringify({ cdpUrl: ENDPOINT }))).toEqual({ cdpUrl: ENDPOINT });
    const mixed = `http://127.0.0.1:65535/${"aZ09-_".repeat(7)}a`;
    expect(parseBrowserPaneSetArgs(JSON.stringify({ cdpUrl: mixed }))).toEqual({ cdpUrl: mixed });
  });

  it.each([
    ["an extra key", JSON.stringify({ cdpUrl: ENDPOINT, extra: 1 })],
    ["a non-loopback host", JSON.stringify({ cdpUrl: `http://192.168.1.4:4242/${TOKEN}` })],
    ["localhost by name", JSON.stringify({ cdpUrl: `http://localhost:4242/${TOKEN}` })],
    ["https", JSON.stringify({ cdpUrl: `https://127.0.0.1:4242/${TOKEN}` })],
    ["a short token", JSON.stringify({ cdpUrl: `http://127.0.0.1:4242/${"A".repeat(42)}` })],
    ["a trailing path", JSON.stringify({ cdpUrl: `${ENDPOINT}/` })],
    ["a non-string cdpUrl", JSON.stringify({ cdpUrl: 42 })],
    ["an array", JSON.stringify([ENDPOINT])],
    ["a bare string", JSON.stringify(ENDPOINT)],
    ["null", "null"],
    ["bad JSON", "{cdpUrl:"],
  ])("rejects %s", (_label, args) => {
    expect(parseBrowserPaneSetArgs(args)).toBeNull();
  });

  it("round-trips the spawner's set message through the parser", () => {
    const message = browserPaneSetMessage(ENDPOINT);
    const prefix = `/${BROWSER_PANE_COMMAND} set `;
    expect(message.startsWith(prefix)).toBe(true);
    expect(parseBrowserPaneSetArgs(message.slice(prefix.length))).toEqual({ cdpUrl: ENDPOINT });
  });
});

describe("navigation allow-lists", () => {
  it.each(["http://localhost:5173/", "https://example.com/a?b=c#d", "about:blank"])(
    "top level allows %s",
    (url) => {
      expect(isAllowedBrowserPaneTopLevelUrl(url)).toBe(true);
    },
  );

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "about:srcdoc",
    "data:text/html,hi",
    "blob:http://localhost/abc",
    "http://example.com/\u0000",
    "http://example.com/\n",
    "http://example.com/\u007f",
    "not a url",
    "",
  ])("top level rejects %j", (url) => {
    expect(isAllowedBrowserPaneTopLevelUrl(url)).toBe(false);
  });

  it("subframes additionally allow about:*, data: and blob:", () => {
    for (const url of ["about:srcdoc", "about:blank", "data:text/html,hi", "blob:http://localhost/abc"]) {
      expect(isAllowedBrowserPaneSubframeUrl(url)).toBe(true);
    }
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://gpu", "data:text/html,\u0001"]) {
      expect(isAllowedBrowserPaneSubframeUrl(url)).toBe(false);
    }
  });
});

describe("hidden instruction", () => {
  it("names the endpoint exactly once", () => {
    const text = browserPaneInstruction(ENDPOINT);
    expect(text.split(ENDPOINT)).toHaveLength(2);
    expect(text).toContain("cdp_url");
  });

  it("carries the direct-tools-first routing policy (#561)", () => {
    const text = browserPaneInstruction(ENDPOINT);
    // Direct interfaces with existing credentials win for structured service work…
    expect(text).toContain("installed CLIs or APIs with existing credentials");
    // …and a service console or interactive sign-in is never the first choice then.
    expect(text).toContain(
      "Do not open a service console or begin interactive sign-in when an authenticated local CLI or API can complete the task",
    );
    // The affirmative pane cases survive: rendered interaction, browser state,
    // browser-only auth, and an explicit user request.
    expect(text).toContain(
      "Use the browser pane for rendered UI, client-side JavaScript, browser state, browser-only authentication, or when the user explicitly asks to see or interact with a page",
    );
    // A CLI/API that demands browser authentication falls back to the pane.
    expect(text).toContain(
      "use the pane for that authentication and then return to the CLI or API",
    );
  });
});
