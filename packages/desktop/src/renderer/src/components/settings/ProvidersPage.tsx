import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  OmpSettingEntry,
  OmpSettingValue,
  ProviderKeysSnapshot,
  ProviderKeyStatus,
  ProviderOAuthState,
  ProviderOAuthStatus,
  WebSearchProviderSnapshot,
} from "@omp-ui/core/types";
import {
  normalizeWebSearchOrder,
  unknownWebSearchProviders,
  WEB_SEARCH_CUSTOM_OPTION,
  webSearchOrderForOption,
  webSearchSelection,
} from "@omp-ui/core/web-search-order";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Button, Chip, Dot, Empty, Label, Panel } from "../ui";
import { FIELD, Row, layerBadge } from "./rows";
import { t, useT } from "../../lib/i18n";
import { OMP_MISSING, type FooterContext, type Load } from "./types";

type ProviderKeysLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: ProviderKeysSnapshot }
  | { status: "error"; message: string };

type OAuthLoad =
  | { status: "loading" }
  | { status: "loaded"; rows: ProviderOAuthStatus[] }
  | { status: "error"; message: string };

type WebSearchLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: WebSearchProviderSnapshot };

/** How the row labels each source, and how loudly. */
function sourceChip(row: ProviderKeyStatus): ReactNode {
  if (row.source === "stored")
    return <Chip tone="signal">{t("settings.providers.savedHere")}</Chip>;
  if (row.source === "environment")
    return <Chip>{t("settings.providers.environment")}</Chip>;
  if (row.source === "login-shell")
    return <Chip tone="iris">{t("settings.providers.shellProfile")}</Chip>;
  // Report-only: omp loads project .env files itself, so nothing was injected.
  if (row.source === "dotenv") return <Chip tone="copper">project .env</Chip>;
  return null;
}

/**
 * One provider row: masked status plus an input that appears on demand. The
 * input is never pre-filled — the renderer has no key material to fill it with,
 * only a masked tail — so typing always means "replace this credential".
 */
function ProviderRow({
  row,
  busy,
  onSave,
  onClear,
}: {
  row: ProviderKeyStatus;
  busy: boolean;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const t = useT();
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
    onSave(value);
  };

  const cancel = (): void => {
    setDraft("");
    setEditing(false);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{row.label}</span>
            {sourceChip(row)}
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {row.activeEnv}
            {row.masked !== null && (
              <span className="ml-2 text-ink-dim">{row.masked}</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!editing && (
            <Button size="xs" disabled={busy} onClick={() => setEditing(true)}>
              {row.source === "stored" ? t("settings.providers.replace") : t("settings.providers.addKey")}
            </Button>
          )}
          {!editing && row.source === "stored" && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={onClear}>
              {t("settings.providers.remove")}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={input}
            // `password` so the value is not readable over a shoulder or in a
            // screen share, and so no password manager offers to autofill it.
            type="password"
            value={draft}
            aria-label={t("settings.providers.keyAria", { name: row.label })}
            placeholder={row.hint ?? row.env}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                // Stopped so Escape closes the editor, not the whole modal.
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            className={cn(FIELD, "flex-1")}
          />
          <Button
            size="xs"
            disabled={busy || draft.trim() === ""}
            onClick={save}
          >
            {t("settings.providers.save")}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={cancel}>
            {t("settings.providers.cancel")}
          </Button>
        </div>
      )}

      {row.shadowsEnvironment && !editing && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {t("settings.providers.shadowsEnvPrefix")}
          <span className="font-mono">{row.activeEnv}</span>
          {t("settings.providers.shadowsEnvSuffix")}
        </p>
      )}
    </div>
  );
}

/** True while any sign-in flow is running — every row's buttons stay out. */
function flowActive(flow: ProviderOAuthState): boolean {
  return flow.phase !== "idle" && flow.phase !== "done" && flow.phase !== "error";
}

/**
 * One subscription row plus, under it while its flow is live, the sign-in
 * panel: the browser phase (link omp opened) and, only if omp asks, the
 * pasted-redirect-URL input. The renderer never sees a token — the row shows
 * omp's own identity strings and the flow state is main's.
 */
function SubscriptionRow({
  row,
  flow,
  flowBusy,
  onSignIn,
  onSignOut,
  onSubmit,
  onCancel,
}: {
  row: ProviderOAuthStatus;
  flow: ProviderOAuthState;
  /** A flow is running somewhere (this row or another) — buttons disabled. */
  flowBusy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const signedIn = row.accounts.length > 0;
  const mine = flow.providerId === row.providerId;

  useEffect(() => {
    if (mine && flow.phase === "input") input.current?.focus();
  }, [mine, flow.phase]);

  const openLink = (): void => {
    if (flow.url) window.open(flow.url, "_blank", "noopener,noreferrer");
  };

  const submit = (): void => {
    const value = draft.trim();
    if (value === "") return;
    setDraft("");
    onSubmit(value);
  };

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink">{row.label}</span>
            {signedIn ? (
              <Chip tone="signal">{t("settings.providers.oauthSignedIn")}</Chip>
            ) : (
              <Chip>{t("settings.providers.oauthNotSignedIn")}</Chip>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {signedIn ? row.accounts.join(", ") : row.hint}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" disabled={flowBusy} onClick={onSignIn}>
            {t("settings.providers.oauthSignIn")}
          </Button>
          {signedIn && (
            <Button size="xs" variant="ghost" disabled={flowBusy} onClick={onSignOut}>
              {t("settings.providers.oauthSignOut")}
            </Button>
          )}
        </div>
      </div>

      {mine && flow.phase === "starting" && (
        <div className="mt-2 flex items-center gap-2">
          <Dot tone="signal" pulse />
          <span className="text-[11px] text-ink-dim">{t("settings.providers.oauthStarting")}</span>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            {t("settings.providers.oauthCancel")}
          </Button>
        </div>
      )}

      {mine && (flow.phase === "browser" || flow.phase === "input") && (
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] leading-relaxed text-ink-dim">
            {t("settings.providers.oauthBrowser")}
          </p>
          {flow.instructions !== null && (
            <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-ink-faint">
              {flow.instructions}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <Button size="xs" onClick={openLink}>
              {t("settings.providers.oauthOpenLink")}
            </Button>
            <Button size="xs" variant="ghost" onClick={onCancel}>
              {t("settings.providers.oauthCancel")}
            </Button>
          </div>
          {flow.phase === "input" && flow.prompt !== null && (
            <div className="flex items-center gap-1.5">
              <input
                ref={input}
                type="text"
                value={draft}
                aria-label={t("settings.providers.oauthInputAria", {
                  name: flow.prompt.title || row.label,
                })}
                placeholder={flow.prompt.placeholder ?? ""}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "Escape") {
                    // Stopped so Escape clears the field, not the whole modal.
                    e.preventDefault();
                    e.stopPropagation();
                    setDraft("");
                  }
                }}
                className={cn(FIELD, "flex-1")}
              />
              <Button size="xs" disabled={draft.trim() === ""} onClick={submit}>
                {t("settings.providers.oauthSubmit")}
              </Button>
            </div>
          )}
        </div>
      )}

      {mine && flow.phase === "done" && (
        <div className="mt-2 flex items-center gap-2">
          <Chip tone="signal">{t("settings.providers.oauthSignedIn")}</Chip>
          <span className="text-[11px] text-ink-dim">
            {t("settings.providers.oauthDone", { label: row.label })}
          </span>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            {t("settings.providers.oauthDismiss")}
          </Button>
        </div>
      )}

      {mine && flow.phase === "error" && (
        <div className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-rose">
            {t("settings.providers.oauthFailed", {
              error: flow.error ?? "",
            })}
          </p>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            {t("settings.providers.oauthDismiss")}
          </Button>
        </div>
      )}
    </div>
  );
}

const WEB_SEARCH_ORDER_KEY = "providers.webSearchOrder";
const WEB_SEARCH_EXCLUDE_KEY = "providers.webSearchExclude";
const WEB_SEARCH_TOOL_KEY = "web_search.enabled";

/**
 * Which provider the native web_search tool tries first. The value and its layer come from
 * omp's own snapshot (never a parallel omp-ui preference); the choices come from the installed
 * omp; the write goes through `omp config set` to the GLOBAL layer only. An order omp-ui cannot
 * represent as "one provider first" stays visible as a labelled custom state rather than being
 * silently collapsed.
 */
function WebSearchProviderRow({
  load,
  entries,
  discovery,
  pendingKey,
  commit,
  retry,
}: {
  load: Load;
  entries: Map<string, OmpSettingEntry>;
  discovery: WebSearchLoad;
  pendingKey: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const t = useT();
  if (load.status === "loading") {
    return (
      <p className="py-2.5 text-[11px] text-ink-faint">{t("settings.omp.reading")}</p>
    );
  }
  // readOmpSettings never rejects — snapshot.error carries omp's own failure —
  // but the IPC hop can, so both land in the same treatment. Unlike the omp
  // page, this one never replaces the whole body: the credentials below stay
  // readable and editable with omp unreachable.
  const failure =
    load.status === "error"
      ? load.message
      : load.status === "loaded" && load.snapshot.error !== null
        ? load.snapshot.error
        : null;
  if (failure !== null || load.status !== "loaded") {
    return (
      <div className="flex items-center justify-between gap-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-rose">
          {t("settings.providers.webSearchUnavailable")}{" "}
          {failure === OMP_MISSING ? t("settings.omp.ompMissingHint") : failure}
        </p>
        <Button size="xs" onClick={retry}>
          {t("settings.omp.retry")}
        </Button>
      </div>
    );
  }

  const entry = entries.get(WEB_SEARCH_ORDER_KEY);
  // omp without the key cannot be configured from here — readOmpSettings'
  // per-entry rule, so the row is simply absent.
  if (entry === undefined) return null;
  if (entry.type !== "array") {
    // A future omp may reshape it into something this control cannot model; show
    // the raw value rather than guess a writer.
    return (
      <Row
        title={t("settings.providers.webSearchOrder")}
        hint={entry.description}
        badge={layerBadge(entry.layer)}
      >
        <span className="max-w-56 truncate font-mono text-[11px] text-ink-mid">
          {entry.value === undefined ? "—" : JSON.stringify(entry.value)}
        </span>
      </Row>
    );
  }

  const order = normalizeWebSearchOrder(entry.value);
  const selection = webSearchSelection(entry.value);
  const list = discovery.status === "loaded" ? discovery.snapshot.providers : [];
  const undiscovered =
    discovery.status === "loaded" && !discovery.snapshot.discovered;
  const extra = unknownWebSearchProviders(order, list);
  const selectValue =
    selection.kind === "automatic"
      ? ""
      : selection.kind === "provider"
        ? selection.provider
        : WEB_SEARCH_CUSTOM_OPTION;
  const excludedOrder = normalizeWebSearchOrder(entries.get(WEB_SEARCH_EXCLUDE_KEY)?.value);
  const chosen = selection.kind === "provider" ? selection.provider : null;
  const toolOff = entries.get(WEB_SEARCH_TOOL_KEY)?.value === false;
  const pending = pendingKey === WEB_SEARCH_ORDER_KEY;

  return (
    <div className="pt-1">
      <Row
        title={t("settings.providers.webSearchOrder")}
        hint={
          entry.layer === "project"
            ? t("settings.providers.webSearchProjectOverride")
            : t("settings.providers.webSearchHint")
        }
        badge={layerBadge(entry.layer)}
      >
        <select
          aria-label={t("settings.providers.webSearchAria")}
          value={selectValue}
          disabled={pending}
          onChange={(event) =>
            commit(WEB_SEARCH_ORDER_KEY, webSearchOrderForOption(event.target.value))
          }
          className={FIELD}
        >
          <option value="">{t("settings.providers.webSearchAutomatic")}</option>
          {list.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          {extra.map((id) => (
            <option key={id} value={id}>
              {t("settings.providers.webSearchUnknown", { provider: id })}
            </option>
          ))}
          {selection.kind === "custom" && (
            <option value={WEB_SEARCH_CUSTOM_OPTION} disabled>
              {t("settings.providers.webSearchCustom", { order: order.join(" → ") })}
            </option>
          )}
        </select>
      </Row>
      {undiscovered && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {t("settings.providers.webSearchUndiscovered")}
        </p>
      )}
      {chosen !== null && excludedOrder.includes(chosen) && (
        <p className="text-[11px] leading-relaxed text-rose">
          {t("settings.providers.webSearchExcluded", { provider: chosen })}
        </p>
      )}
      {toolOff && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {t("settings.providers.webSearchToolOff")}
        </p>
      )}
    </div>
  );
}

export function ProvidersPage({
  projectCwd,
  load,
  pendingKey,
  ompError,
  commit,
  retry,
}: {
  projectCwd: string | null;
  /** The shell's omp-settings snapshot: where webSearchOrder's value and layer live. */
  load: Load;
  pendingKey: string | null;
  /** The shell's omp-write failure, shown beside this page's own credential errors. */
  ompError: string | null;
  commit: (key: string, value: OmpSettingValue) => void;
  retry: () => void;
}) {
  const t = useT();
  const readProviderKeys = useStore((s) => s.readProviderKeys);
  const setProviderKey = useStore((s) => s.setProviderKey);
  const clearProviderKey = useStore((s) => s.clearProviderKey);
  const readProviderOAuth = useStore((s) => s.readProviderOAuth);
  const startProviderOAuth = useStore((s) => s.startProviderOAuth);
  const submitProviderOAuthInput = useStore((s) => s.submitProviderOAuthInput);
  const cancelProviderOAuth = useStore((s) => s.cancelProviderOAuth);
  const signOutProviderOAuth = useStore((s) => s.signOutProviderOAuth);
  const providerOAuth = useStore((s) => s.providerOAuth);
  const readWebSearchProviders = useStore((s) => s.readWebSearchProviders);

  const [keysLoad, setKeysLoad] = useState<ProviderKeysLoad>({ status: "loading" });
  const [oauth, setOauth] = useState<OAuthLoad>({ status: "loading" });
  const [webSearch, setWebSearch] = useState<WebSearchLoad>({ status: "loading" });
  /** env name of the row with a write in flight; its controls stay disabled. */
  const [pendingEnv, setPendingEnv] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const gen = useRef(0);
  const oauthGen = useRef(0);
  const webSearchGen = useRef(0);
  const previousPhase = useRef<ProviderOAuthState["phase"]>("idle");

  useEffect(() => {
    const g = ++gen.current;
    setKeysLoad({ status: "loading" });
    readProviderKeys(projectCwd).then(
      (snapshot) => {
        if (g === gen.current) setKeysLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g === gen.current)
          setKeysLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readProviderKeys, projectCwd]);

  // A second, independent read: the subscription group must render (or show
  // its own error) without hiding the API-key groups behind a failure.
  useEffect(() => {
    const g = ++oauthGen.current;
    setOauth({ status: "loading" });
    readProviderOAuth().then(
      (rows) => {
        if (g === oauthGen.current) setOauth({ status: "loaded", rows });
      },
      (err: unknown) => {
        if (g === oauthGen.current)
          setOauth({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readProviderOAuth]);

  // A third independent read: the installed omp's own provider list (ADR-0027).
  // Its failure must not blank the page — the row then lists configured ids only.
  useEffect(() => {
    const g = ++webSearchGen.current;
    setWebSearch({ status: "loading" });
    readWebSearchProviders().then(
      (snapshot) => {
        if (g === webSearchGen.current) setWebSearch({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g !== webSearchGen.current) return;
        setWebSearch({
          status: "loaded",
          snapshot: { providers: [], discovered: false, error: displayMessage(err) },
        });
      },
    );
  }, [readWebSearchProviders]);

  // A finished sign-in adds accounts: re-read the rows (main already
  // refreshed its cache before publishing "done").
  useEffect(() => {
    const phase = providerOAuth.phase;
    if (previousPhase.current === "done" && phase === "done") {
      previousPhase.current = phase;
      return;
    }
    if (phase === "done" && previousPhase.current !== "done") {
      const g = ++oauthGen.current;
      readProviderOAuth().then(
        (rows) => {
          if (g === oauthGen.current) setOauth({ status: "loaded", rows });
        },
        (err: unknown) => {
          if (g === oauthGen.current)
            setOauth({ status: "error", message: displayMessage(err) });
        },
      );
    }
    previousPhase.current = phase;
  }, [providerOAuth.phase, readProviderOAuth]);

  /** Every write answers with the refreshed snapshot, so no re-read is needed. */
  const run = (envName: string, op: Promise<ProviderKeysSnapshot>): void => {
    setPendingEnv(envName);
    op.then(
      (snapshot) => {
        setWriteError(null);
        setKeysLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => setWriteError(displayMessage(err)),
    ).finally(() => setPendingEnv(null));
  };

  const signIn = (id: string): void => {
    void startProviderOAuth(id).catch((err: unknown) =>
      setWriteError(displayMessage(err)),
    );
  };

  const signOut = (id: string): void => {
    setPendingEnv(id);
    signOutProviderOAuth(id).then(
      (rows) => {
        setWriteError(null);
        // The response carries the refreshed rows — no re-read.
        setOauth({ status: "loaded", rows });
      },
      (err: unknown) => setWriteError(displayMessage(err)),
    ).finally(() => setPendingEnv(null));
  };

  const submit = (value: string): void => {
    void submitProviderOAuthInput(value).catch((err: unknown) =>
      setWriteError(displayMessage(err)),
    );
  };

  if (keysLoad.status === "loading") {
    return <Empty title={t("settings.providers.reading")} />;
  }
  if (keysLoad.status === "error") {
    return <Empty title={t("settings.providers.readFailed")} hint={keysLoad.message} />;
  }

  const { providers, encryptionAvailable, backend } = keysLoad.snapshot;
  const oauthRows = oauth.status === "loaded" ? oauth.rows : [];
  const configured = providers.filter((p) => p.source !== "none");
  const configuredCount =
    configured.length + oauthRows.filter((r) => r.accounts.length > 0).length;
  const totalCount = providers.length + oauthRows.length;
  const groups: ReadonlyArray<{
    id: ProviderKeyStatus["group"];
    label: string;
  }> = [
    { id: "models", label: t("settings.providers.modelProviders") },
    { id: "search", label: t("settings.providers.webSearch") },
  ];

  // The web-search row reads its value from the shell's snapshot, the same
  // `byKey` map the omp page builds (one Map per render, no per-row scans).
  const ompEntries = new Map<string, OmpSettingEntry>(
    load.status === "loaded" ? load.snapshot.entries.map((e) => [e.key, e]) : [],
  );

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={configuredCount > 0 ? "signal" : "copper"} />
          <p className="text-xs font-medium text-ink">
            {configuredCount === 0
              ? t("settings.providers.noneConfigured")
              : t("settings.providers.someConfigured", {
                  configured: configuredCount,
                  total: totalCount,
                })}
          </p>
        </div>
        {encryptionAvailable ? (
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            {t("settings.providers.encryptedPrefix")}
            <span className="font-mono">{backend}</span>
            {t("settings.providers.encryptedSuffix")}
          </p>
        ) : (
          <p className="mt-1.5 text-[11px] leading-relaxed text-copper">
            {t("settings.providers.noCredentialStore")}
          </p>
        )}
      </Panel>

      {(writeError ?? ompError) !== null && (
        <p className="text-[11px] leading-relaxed text-rose">
          {writeError ?? ompError}
        </p>
      )}

      {groups.map(({ id, label }, index) => {
        const rows = providers.filter((p) => p.group === id);
        const withSubscription = (
          <div key="oauth" className="space-y-0.5">
            <Label>{t("settings.providers.oauthGroup")}</Label>
            {oauth.status === "error" ? (
              <p className="py-2.5 text-[11px] leading-relaxed text-rose">
                {t("settings.providers.oauthReadFailed")}
                {oauth.message}
              </p>
            ) : oauth.status === "loaded" ? (
              <div className="divide-y divide-line-soft">
                {oauthRows.map((row) => (
                  <SubscriptionRow
                    key={row.id}
                    row={row}
                    flow={providerOAuth}
                    flowBusy={flowActive(providerOAuth)}
                    onSignIn={() => signIn(row.id)}
                    onSignOut={() => signOut(row.id)}
                    onSubmit={submit}
                    onCancel={() => void cancelProviderOAuth()}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
        if (rows.length === 0 && index === 0) return null;
        return (
          <div key={id} className="space-y-3">
            <div className="space-y-0.5">
              <Label>{label}</Label>
              <div className="divide-y divide-line-soft">
                {rows.map((row) => (
                  <ProviderRow
                    key={row.id}
                    row={row}
                    busy={pendingEnv !== null}
                    onSave={(value) => run(row.env, setProviderKey(row.env, value))}
                    onClear={() => run(row.env, clearProviderKey(row.activeEnv))}
                  />
                ))}
                {id === "search" && (
                  <WebSearchProviderRow
                    load={load}
                    entries={ompEntries}
                    discovery={webSearch}
                    pendingKey={pendingKey}
                    commit={commit}
                    retry={retry}
                  />
                )}
              </div>
            </div>
            {index === 0 && withSubscription}
          </div>
        );
      })}
    </div>
  );
}

export function ProvidersFooter({ anyLive }: FooterContext) {
  // Load-bearing: keys bind at process start, and a GUI launch inherits none
  // of the user's shell exports — the two facts that make this page exist.
  const t = useT();
  return (
    <p>
      {t("settings.providers.footerIntro")}
      {anyLive && t("settings.providers.footerRestart")}
      {t("settings.providers.footerEnvPrefix")}
      <span className="font-mono">.env</span>
      {t("settings.providers.footerEnvSuffix")}
      {t("settings.providers.oauthFooter")}
    </p>
  );
}
