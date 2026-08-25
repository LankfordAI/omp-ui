import { useEffect, useRef, useState } from "react";
import type { RemoteState } from "@omp-ui/core/types";
import QRCode from "qrcode";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import {
  Button,
  ChoiceCapsule,
  CopyButton,
  Dot,
  Label,
  Panel,
  Switch,
} from "../ui";
import { CommitField, FIELD, Row } from "./rows";

function remoteStatusLine(r: RemoteState): string {
  switch (r.status) {
    case "starting":
      return "starting…";
    case "listening":
      return `listening on ${r.port}`;
    case "error":
      return r.error ?? "the server could not start";
    default:
      return "stopped";
  }
}

function remoteStatusTone(
  status: RemoteState["status"],
): "signal" | "copper" | "rose" | "neutral" {
  if (status === "listening") return "signal";
  if (status === "starting") return "copper";
  if (status === "error") return "rose";
  return "neutral";
}

/**
 * The QR of the pairing URL. Rendered as an SVG string rather than a canvas: qrcode's `browser`
 * field remaps its entry and stubs `fs`, so `toString(..., { type: "svg" })` is the one route that
 * needs no polyfill in either the renderer or the web bundle.
 */
function PairingQr({ url, hasPassword }: { url: string; hasPassword: boolean }) {
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
        // A QR that will not render must not take the page down — the URL above still copies.
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
        <Label>Scan to pair</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {hasPassword
            ? "Opens omp-ui in the phone&apos;s browser; it will ask for your password."
            : "Opens omp-ui in the phone&apos;s browser with the token already attached."}
        </p>
      </div>
    </Panel>
  );
}

/**
 * The remote sign-in password row. Mirrors ProviderRow: self-managed editing/draft state, the
 * input never pre-filled (only a hash exists server-side, nothing to reveal), Enter saves,
 * Escape cancels without closing the modal.
 */
function PasswordRow() {
  const hasPassword = useStore((s) => s.remote.hasPassword);
  const setRemotePassword = useStore((s) => s.setRemotePassword);
  const clearRemotePassword = useStore((s) => s.clearRemotePassword);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const save = (): void => {
    const value = draft.trim();
    if (value === "") return;
    setDraft("");
    setEditing(false);
    void setRemotePassword(value); // policy rejections surface via alertRemoteError
  };

  const cancel = (): void => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink">Password</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            Primary sign-in for remote devices. Stored as a salted hash — it cannot
            be revealed, only changed or cleared.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!editing && !hasPassword && (
            <Button size="xs" onClick={() => setEditing(true)}>
              Set password
            </Button>
          )}
          {!editing && hasPassword && (
            <>
              <span className="text-[11px] text-ink-mid">password set</span>
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                Change
              </Button>
              <Button size="xs" onClick={() => void clearRemotePassword()}>
                Clear
              </Button>
            </>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={input}
            type="password"
            value={draft}
            aria-label="remote access password"
            placeholder="at least 8 characters"
            spellCheck={false}
            autoComplete="new-password"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                // Stopped so Escape cancels the row, not the whole modal.
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            className={cn(FIELD, "flex-1")}
          />
          <Button size="xs" disabled={draft.trim() === ""} onClick={save}>
            Save
          </Button>
          <Button size="xs" variant="ghost" onClick={cancel}>
            cancel
          </Button>
        </div>
      )}
    </div>
  );
}

const REMOTE_BIND_OPTIONS = [
  { value: "localhost", label: "localhost" },
  { value: "lan", label: "local network" },
] as const;

export function RemotePage() {
  const remote = useStore((s) => s.remote);
  const setRemoteEnabled = useStore((s) => s.setRemoteEnabled);
  const setRemoteBind = useStore((s) => s.setRemoteBind);
  const setRemotePort = useStore((s) => s.setRemotePort);
  const regenerateRemoteToken = useStore((s) => s.regenerateRemoteToken);
  const [revealed, setRevealed] = useState(false);

  const primaryUrl = remote.urls[0] ?? null;

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot
            tone={remoteStatusTone(remote.status)}
            pulse={remote.status === "starting"}
          />
          <p className="text-xs font-medium text-ink">
            {remoteStatusLine(remote)}
          </p>
        </div>
        {remote.webBundleMissing && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-copper">
            the browser bundle is missing — run{" "}
            <span className="font-mono">npm run build:web</span>
          </p>
        )}
      </Panel>

      <div className="divide-y divide-line-soft">
        <Row
          title="Enable remote access"
          hint="Off by default. A connected client can do everything you can, including editing files and running commands."
        >
          <Switch
            on={remote.enabled}
            onChange={(next) => void setRemoteEnabled(next)}
            label="enable remote access"
          />
        </Row>
        <div>
          <Row
            title="Bind address"
            hint="Which interface the server listens on."
          >
            <ChoiceCapsule
              label="bind address"
              value={remote.bind}
              options={REMOTE_BIND_OPTIONS}
              onChange={(value) => void setRemoteBind(value)}
              optionClassName="px-2 text-[11px]"
            />
          </Row>
          {remote.bind === "lan" && (
            <p className="pb-2.5 text-[11px] leading-relaxed text-rose">
              Anyone on this network with your password or a token link can drive your agent.
              Plain HTTP, so the connection is not encrypted.
            </p>
          )}
        </div>
        <Row title="Port" hint="A whole number between 1024 and 65535.">
          <CommitField
            current={String(remote.port)}
            kind="number"
            label="remote access port"
            disabled={false}
            className="w-24"
            onCommit={(raw) => void setRemotePort(Number(raw))}
          />
        </Row>
        <PasswordRow />
        <Row
          title="Access token (fallback)"
          hint="Still works while a password is set. Regenerating disconnects every client using it."
        >
          <div className="flex items-center gap-1.5">
            <span
              data-selectable
              className="max-w-48 truncate font-mono text-[11px] text-ink-mid"
              title={revealed ? remote.token : undefined}
            >
              {revealed ? remote.token : "••••••••••••"}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? "hide" : "reveal"}
            </Button>
            <CopyButton text={remote.token} />
            <Button size="xs" onClick={() => void regenerateRemoteToken()}>
              Regenerate
            </Button>
          </div>
        </Row>
        <Row
          title="Connection URL"
          hint={
            remote.hasPassword
              ? "Open this on the other device, then sign in with your password."
              : "Open this on the other device — the token rides along."
          }
        >
          <div className="flex items-center gap-1.5">
            <span
              data-selectable
              className="max-w-64 truncate font-mono text-[11px] text-ink-mid"
              title={primaryUrl ?? undefined}
            >
              {primaryUrl ?? "—"}
            </span>
            {primaryUrl !== null && <CopyButton text={primaryUrl} />}
          </div>
        </Row>
        {remote.hasPassword && (
          <Row
            title="Token link (fallback)"
            hint="Full-access URL with the embedded token, for devices where typing a password is impractical."
          >
            <div className="flex items-center gap-1.5">
              <span
                data-selectable
                className="max-w-64 truncate font-mono text-[11px] text-ink-mid"
                title={remote.tokenUrls[0] ?? undefined}
              >
                {remote.tokenUrls[0] ?? "—"}
              </span>
              {remote.tokenUrls[0] !== undefined && (
                <CopyButton text={remote.tokenUrls[0]} />
              )}
            </div>
          </Row>
        )}
      </div>

      {remote.urls.length > 1 && (
        <div className="space-y-0.5">
          <Label>Also reachable at</Label>
          {remote.urls.slice(1).map((url) => (
            <p
              key={url}
              data-selectable
              className="truncate font-mono text-[11px] text-ink-faint"
            >
              {url}
            </p>
          ))}
        </div>
      )}

      {remote.status === "listening" && primaryUrl !== null && (
        <PairingQr url={primaryUrl} hasPassword={remote.hasPassword} />
      )}
    </div>
  );
}
