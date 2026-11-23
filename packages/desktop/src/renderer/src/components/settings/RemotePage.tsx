import { useEffect, useRef, useState } from "react";
import type { RemoteState } from "@omp-ui/core/types";
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
import { PairingQr } from "../PairingQr";
import { McpEndpointSection } from "./McpEndpointSection";

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
    void setRemotePassword(value); // policy rejections surface as error notices
  };

  const cancel = (): void => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Password</p>
          <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">
            Primary sign-in for remote devices. Stored as a salted hash — it cannot be revealed, only changed or cleared.
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
              <span className="text-xs text-ink-mid">password set</span>
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
          <p className="text-sm font-medium text-ink">
            {remoteStatusLine(remote)}
          </p>
        </div>
        {remote.webBundleMissing && (
          <p className="mt-1.5 text-sm leading-relaxed text-copper">
            {"the browser bundle was missing at server startup — if it is still missing, run "}
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
              options={[
                { value: "localhost", label: "localhost" },
                { value: "lan", label: "local network" },
              ] as const}
              onChange={(value) => void setRemoteBind(value)}
              optionClassName="tab-label px-2"
            />
          </Row>
          {remote.bind === "lan" && (
            <p className="pb-2.5 text-sm leading-relaxed text-rose">
              Anyone on this network with your password or a token link can drive your agent. Plain HTTP, so the connection is not encrypted.
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
              className="max-w-48 truncate font-mono text-xs text-ink-mid"
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
              className="max-w-64 truncate font-mono text-xs text-ink-mid"
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
                className="max-w-64 truncate font-mono text-xs text-ink-mid"
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
              className="truncate font-mono text-xs text-ink-faint"
            >
              {url}
            </p>
          ))}
        </div>
      )}

      {remote.status === "listening" && primaryUrl !== null && (
        <PairingQr
          url={primaryUrl}
          title="Scan to pair"
          caption={remote.hasPassword ? "Opens omp-ui in the phone's browser; it will ask for your password." : "Opens omp-ui in the phone's browser with the token already attached."}
        />
      )}

      <McpEndpointSection />
    </div>
  );
}

export function RemoteFooter() {
  // Load-bearing honesty: installability and offline are secure-context-only, so a plain
  // http://<lan-ip> origin cannot have them no matter what the manifest says. The origin
  // token stays a JSX literal: catalog values may not contain angle brackets (i18n.test.ts
  // "keeps every catalog value plain text"), same as the .env / config.yml tokens in the
  // other Settings footers.
  return (
    <p>
      {"Over localhost the app is a full browser app. Over your local network it works as a responsive web app, but browsers reserve installability and offline support for secure origins — plain "}
      <span className="font-mono">http://&lt;lan-ip&gt;</span>
      {" is not one, so there is no install prompt until you front this with your own HTTPS (a TLS terminator, or Tailscale serve)."}
      {" Changing anything here restarts only the server; sessions keep running."}
    </p>
  );
}
