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
import { t, useT } from "../../lib/i18n";

function remoteStatusLine(r: RemoteState): string {
  switch (r.status) {
    case "starting":
      return t("settings.remote.starting");
    case "listening":
      return t("settings.remote.listening", { port: r.port });
    case "error":
      return r.error ?? t("settings.remote.startFailed");
    default:
      return t("settings.remote.stopped");
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
  const t = useT();

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
        <Label>{t("settings.remote.scanToPair")}</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {hasPassword
            ? t("settings.remote.pairPassword")
            : t("settings.remote.pairToken")}
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
  const t = useT();
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
          <p className="text-xs font-medium text-ink">{t("settings.remote.password")}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            {t("settings.remote.passwordHint")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!editing && !hasPassword && (
            <Button size="xs" onClick={() => setEditing(true)}>
              {t("settings.remote.setPassword")}
            </Button>
          )}
          {!editing && hasPassword && (
            <>
              <span className="text-[11px] text-ink-mid">{t("settings.remote.passwordSet")}</span>
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                {t("settings.remote.change")}
              </Button>
              <Button size="xs" onClick={() => void clearRemotePassword()}>
                {t("settings.remote.clear")}
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
            aria-label={t("settings.remote.passwordAria")}
            placeholder={t("settings.remote.passwordPlaceholder")}
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
            {t("settings.remote.save")}
          </Button>
          <Button size="xs" variant="ghost" onClick={cancel}>
            {t("settings.remote.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function RemotePage() {
  const t = useT();
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
            {t("settings.remote.webBundleMissing")}
            <span className="font-mono">npm run build:web</span>
          </p>
        )}
      </Panel>

      <div className="divide-y divide-line-soft">
        <Row
          title={t("settings.remote.enable")}
          hint={t("settings.remote.enableHint")}
        >
          <Switch
            on={remote.enabled}
            onChange={(next) => void setRemoteEnabled(next)}
            label={t("settings.remote.enableLabel")}
          />
        </Row>
        <div>
          <Row
            title={t("settings.remote.bind")}
            hint={t("settings.remote.bindHint")}
          >
            <ChoiceCapsule
              label={t("settings.remote.bindLabel")}
              value={remote.bind}
              options={[
                { value: "localhost", label: "localhost" },
                { value: "lan", label: t("settings.remote.bindLocalNetwork") },
              ] as const}
              onChange={(value) => void setRemoteBind(value)}
              optionClassName="px-2 text-[11px]"
            />
          </Row>
          {remote.bind === "lan" && (
            <p className="pb-2.5 text-[11px] leading-relaxed text-rose">
              {t("settings.remote.lanWarning")}
            </p>
          )}
        </div>
        <Row title={t("settings.remote.port")} hint={t("settings.remote.portHint")}>
          <CommitField
            current={String(remote.port)}
            kind="number"
            label={t("settings.remote.portAria")}
            disabled={false}
            className="w-24"
            onCommit={(raw) => void setRemotePort(Number(raw))}
          />
        </Row>
        <PasswordRow />
        <Row
          title={t("settings.remote.accessToken")}
          hint={t("settings.remote.accessTokenHint")}
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
              {revealed ? t("settings.remote.hide") : t("settings.remote.reveal")}
            </Button>
            <CopyButton text={remote.token} />
            <Button size="xs" onClick={() => void regenerateRemoteToken()}>
              {t("settings.remote.regenerate")}
            </Button>
          </div>
        </Row>
        <Row
          title={t("settings.remote.connectionUrl")}
          hint={
            remote.hasPassword
              ? t("settings.remote.connectionUrlHintPassword")
              : t("settings.remote.connectionUrlHintToken")
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
            title={t("settings.remote.tokenLink")}
            hint={t("settings.remote.tokenLinkHint")}
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
          <Label>{t("settings.remote.alsoReachable")}</Label>
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

export function RemoteFooter() {
  // Load-bearing honesty: installability and offline are secure-context-only, so a plain
  // http://<lan-ip> origin cannot have them no matter what the manifest says.
  return (
    <p>
      Over localhost the app is a full browser app. Over your local network it
      works as a responsive web app, but browsers reserve installability and
      offline support for secure origins — plain{" "}
      <span className="font-mono">http://&lt;lan-ip&gt;</span> is not one, so
      there is no install prompt until you front this with your own HTTPS (a
      TLS terminator, or Tailscale serve). Changing anything here restarts
      only the server; sessions keep running.
    </p>
  );
}
