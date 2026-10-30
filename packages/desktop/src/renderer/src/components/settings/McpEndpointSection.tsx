import { useState } from "react";
import {
  MCP_DEFAULT_RATE_PER_HOUR,
  MCP_TOKEN_PLACEHOLDER,
  mcpClientConfig,
  mcpEndpointUrl,
  validateMcpClientName,
  validateMcpRate,
  type McpCallOutcome,
  type McpClientRecord,
  type McpScope,
  type McpTokenReveal,
} from "@omp-ui/core/mcp-endpoint";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { localeTag, useT, type MessageKey } from "../../lib/i18n";
import { useStore } from "../../store";
import { Button, ChoiceCapsule, CopyButton, Label, Panel, Switch } from "../ui";
import { FIELD, Row } from "./rows";

/**
 * Settings → Remote access → MCP endpoint (issue #996, ADR-0080): omp-ui's
 * own MCP server on the remote-access listener. Each client has its own
 * token and scope; the token crosses the wire only in create/rotate replies,
 * and this section holds it in component state for the one reveal.
 */

const SCOPE_LABEL: Record<McpScope, MessageKey> = {
  read: "settings.mcpEndpoint.scope.read",
  dispatch: "settings.mcpEndpoint.scope.dispatch",
  send: "settings.mcpEndpoint.scope.send",
};

const OUTCOME_LABEL: Record<McpCallOutcome, MessageKey> = {
  ok: "settings.mcpEndpoint.outcome.ok",
  refused: "settings.mcpEndpoint.outcome.refused",
  forbidden: "settings.mcpEndpoint.outcome.forbidden",
  "rate-limited": "settings.mcpEndpoint.outcome.rateLimited",
  error: "settings.mcpEndpoint.outcome.error",
};

function ScopeCapsule({ value, onChange }: { value: McpScope; onChange: (scope: McpScope) => void }) {
  const t = useT();
  return (
    <ChoiceCapsule
      label={t("settings.mcpEndpoint.form.scope")}
      value={value}
      options={[
        { value: "read", label: t(SCOPE_LABEL.read) },
        { value: "dispatch", label: t(SCOPE_LABEL.dispatch) },
        { value: "send", label: t(SCOPE_LABEL.send) },
      ] as const}
      onChange={onChange}
      optionClassName="px-2 text-[11px]"
    />
  );
}

/** The one-time token panel; Done drops the token from component state. */
function TokenReveal({ reveal, url, onDone }: { reveal: McpTokenReveal; url: string | null; onDone: () => void }) {
  const t = useT();
  return (
    <Panel tone="copper" className="px-4 py-3">
      <p className="text-xs font-medium text-ink">{t("settings.mcpEndpoint.reveal.title", { name: reveal.client.name })}</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.mcpEndpoint.reveal.once")}</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span data-selectable data-testid="mcp-token" className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">
          {reveal.token}
        </span>
        <CopyButton text={reveal.token} />
      </div>
      {url !== null && (
        <div className="mt-2 flex items-center gap-1.5">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-mid">{t("settings.mcpEndpoint.reveal.config")}</p>
          <CopyButton
            text={mcpClientConfig(url, reveal.token)}
            label={t("settings.mcpEndpoint.copyUrl")}
            doneLabel={t("common.button.copied")}
          />
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <Button size="xs" variant="solid" onClick={onDone}>
          {t("settings.mcpEndpoint.reveal.done")}
        </Button>
      </div>
    </Panel>
  );
}

function CreateForm({ onCreated }: { onCreated: (reveal: McpTokenReveal) => void }) {
  const t = useT();
  const createMcpClient = useStore((s) => s.createMcpClient);
  const [name, setName] = useState("");
  // Least privilege by default (ADR-0080): a new client can only read.
  const [scope, setScope] = useState<McpScope>("read");
  const [rate, setRate] = useState(String(MCP_DEFAULT_RATE_PER_HOUR));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (busy) return;
    let input: { name: string; scope: McpScope; enabled: boolean; ratePerHour: number | null };
    try {
      input = {
        name: validateMcpClientName(name),
        scope,
        enabled: true,
        ratePerHour: validateMcpRate(rate.trim() === "" ? null : Number(rate)),
      };
    } catch (err) {
      setError(displayMessage(err));
      return;
    }
    setBusy(true);
    setError(null);
    createMcpClient(input)
      .then(
        (reveal) => {
          setName("");
          onCreated(reveal);
        },
        (err: unknown) => setError(displayMessage(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="divide-y divide-line-soft">
      <Row title={t("settings.mcpEndpoint.form.name")} hint={t("settings.mcpEndpoint.form.nameHint")}>
        <input
          type="text"
          value={name}
          aria-label={t("settings.mcpEndpoint.form.name")}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          className={cn(FIELD, "w-56")}
        />
      </Row>
      <Row title={t("settings.mcpEndpoint.form.scope")} hint={t("settings.mcpEndpoint.form.scopeHint")}>
        <ScopeCapsule value={scope} onChange={setScope} />
      </Row>
      <Row title={t("settings.mcpEndpoint.form.rate")} hint={t("settings.mcpEndpoint.form.rateHint")}>
        <input
          type="number"
          min={1}
          value={rate}
          aria-label={t("settings.mcpEndpoint.form.rate")}
          disabled={busy}
          onChange={(e) => setRate(e.target.value)}
          className={cn(FIELD, "w-24")}
        />
      </Row>
      <div className="flex items-center gap-3 py-2.5">
        {error !== null && (
          <p role="alert" className="min-w-0 flex-1 text-[11px] leading-relaxed text-rose">
            {error}
          </p>
        )}
        <Button variant="solid" size="xs" className="ml-auto" disabled={busy} onClick={submit}>
          {busy ? t("settings.mcpEndpoint.action.creating") : t("settings.mcpEndpoint.action.create")}
        </Button>
      </div>
    </div>
  );
}

function ClientPanel({
  client,
  url,
  onRotated,
}: {
  client: McpClientRecord;
  url: string | null;
  onRotated: (reveal: McpTokenReveal) => void;
}) {
  const t = useT();
  const updateMcpClient = useStore((s) => s.updateMcpClient);
  const rotateMcpToken = useStore((s) => s.rotateMcpToken);
  const removeMcpClient = useStore((s) => s.removeMcpClient);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rotate = (): void => {
    setRotating(true);
    setError(null);
    rotateMcpToken(client.id)
      .then(onRotated, (err: unknown) => setError(displayMessage(err)))
      .finally(() => setRotating(false));
  };

  return (
    <Panel className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-ink">{client.name}</p>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            {client.ratePerHour === null
              ? t("settings.mcpEndpoint.rate.none")
              : t("settings.mcpEndpoint.rate.perHour", { count: client.ratePerHour })}
          </p>
        </div>
        <Switch
          on={client.enabled}
          onChange={(next) => void updateMcpClient(client.id, { enabled: next })}
          label={t("settings.mcpEndpoint.enabledLabel", { name: client.name })}
        />
      </div>
      <div className="mt-2">
        <ScopeCapsule value={client.scope} onChange={(scope) => void updateMcpClient(client.id, { scope })} />
      </div>
      {error !== null && (
        <p role="alert" className="mt-1.5 text-[11px] leading-relaxed text-rose">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {url !== null && (
          <CopyButton
            text={mcpClientConfig(url, MCP_TOKEN_PLACEHOLDER)}
            label={t("settings.mcpEndpoint.copyUrl")}
            doneLabel={t("common.button.copied")}
          />
        )}
        <Button size="xs" variant="ghost" disabled={rotating} onClick={rotate}>
          {t("settings.mcpEndpoint.action.rotate")}
        </Button>
        {confirmingDelete ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              {t("settings.mcpEndpoint.action.cancel")}
            </Button>
            <Button size="xs" variant="solid" tone="rose" onClick={() => void removeMcpClient(client.id)}>
              {t("settings.mcpEndpoint.action.confirmDelete")}
            </Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" tone="rose" onClick={() => setConfirmingDelete(true)}>
            {t("settings.mcpEndpoint.action.delete")}
          </Button>
        )}
      </div>
    </Panel>
  );
}

function CallLog() {
  const t = useT();
  const calls = useStore((s) => s.mcpEndpoint.calls);
  const clearMcpCalls = useStore((s) => s.clearMcpCalls);
  const newestFirst = [...calls].reverse();

  return (
    <div>
      <div className="flex items-center gap-2">
        <Label>{t("settings.mcpEndpoint.calls.title")}</Label>
        {calls.length > 0 && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void clearMcpCalls()}>
            {t("settings.mcpEndpoint.calls.clear")}
          </Button>
        )}
      </div>
      {newestFirst.length === 0 ? (
        <p className="mt-1 text-[11px] text-ink-faint">{t("settings.mcpEndpoint.calls.empty")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-line-soft" data-testid="mcp-calls">
          {newestFirst.map((c) => (
            <li key={c.id} className="py-1.5 text-[11px]">
              <p className="truncate text-ink">
                <span className="text-ink-faint">{new Date(c.at).toLocaleString(localeTag())}</span>
                {` · ${c.clientName} · `}
                <span className="font-mono">{c.tool}</span>
                {c.target !== null && <span className="font-mono text-ink-mid">{` · ${c.target}`}</span>}
              </p>
              <p className="truncate text-ink-faint">
                <span className={c.outcome === "ok" ? "text-signal" : "text-rose"}>{t(OUTCOME_LABEL[c.outcome])}</span>
                {` · ${c.remoteAddress} · ${c.durationMs} ms`}
                {c.message !== null && ` · ${c.message}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function McpEndpointSection() {
  const t = useT();
  const mcp = useStore((s) => s.mcpEndpoint);
  const remote = useStore((s) => s.remote);
  const setMcpEndpointEnabled = useStore((s) => s.setMcpEndpointEnabled);
  // The one place a token lives in the renderer: dropped on Done (ADR-0080).
  const [reveal, setReveal] = useState<McpTokenReveal | null>(null);
  const url = remote.status === "listening" ? mcpEndpointUrl(remote.urls) : null;

  return (
    <section className="space-y-3 border-t border-line-soft pt-3" aria-label={t("settings.mcpEndpoint.title")}>
      <Label>{t("settings.mcpEndpoint.title")}</Label>
      <p className="text-[11px] leading-relaxed text-ink-faint">{t("settings.mcpEndpoint.intro")}</p>
      <p className="text-[11px] leading-relaxed text-copper">{t("settings.mcpEndpoint.warning")}</p>
      <div className="divide-y divide-line-soft">
        <Row title={t("settings.mcpEndpoint.accept")} hint={t("settings.mcpEndpoint.acceptHint")}>
          <Switch on={mcp.enabled} onChange={(next) => void setMcpEndpointEnabled(next)} label={t("settings.mcpEndpoint.accept")} />
        </Row>
        <Row title={t("settings.mcpEndpoint.url")} hint={t("settings.mcpEndpoint.urlHint")}>
          <span data-selectable className="max-w-64 truncate font-mono text-[11px] text-ink-mid" title={url ?? undefined}>
            {url ?? "—"}
          </span>
        </Row>
      </div>

      {reveal !== null && <TokenReveal reveal={reveal} url={url} onDone={() => setReveal(null)} />}

      {mcp.clients.length > 0 && (
        <div className="space-y-2">
          {mcp.clients.map((client) => (
            <ClientPanel key={client.id} client={client} url={url} onRotated={setReveal} />
          ))}
        </div>
      )}

      <div>
        <Label>{t("settings.mcpEndpoint.createTitle")}</Label>
        <CreateForm onCreated={setReveal} />
      </div>

      <CallLog />
    </section>
  );
}
