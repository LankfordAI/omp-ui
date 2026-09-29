import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Label, Panel } from "./ui";

/**
 * A scannable QR rendered as an SVG string rather than a canvas: qrcode's
 * `browser` field remaps its entry and stubs `fs`, so `toString(..., {
 * type: "svg" })` is the one route that needs no polyfill in either the
 * renderer or the web bundle (extracted from the remote settings page for
 * the live-share dialog, issue #686).
 */
export function PairingQr({ url, title, caption }: { url: string; title: string; caption: string }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let live = true;
    setSvg("");
    void QRCode.toString(url, {
      type: "svg",
      margin: 1,
      // Deliberately NOT theme tokens: a scannable QR needs true black on true white, and a
      // camera does not care about the app's palette.
      color: { dark: "#000000", light: "#ffffff" },
    }).then(
      (out) => {
        if (live) setSvg(out);
      },
      () => {
        // A QR that will not render must not take the surface down — the URL above still copies.
      },
    );
    return () => {
      live = false;
    };
  }, [url]);

  if (svg === "") return null;
  return (
    <Panel className="flex items-center gap-3 px-4 py-3">
      <div
        className="size-32 shrink-0 rounded-md bg-white p-1.5"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div className="min-w-0">
        <Label>{title}</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{caption}</p>
      </div>
    </Panel>
  );
}
