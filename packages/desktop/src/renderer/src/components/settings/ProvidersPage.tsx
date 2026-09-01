import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ProviderKeysSnapshot,
  ProviderKeyStatus,
} from "@omp-ui/core/types";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Button, Chip, Dot, Empty, Label, Panel } from "../ui";
import { FIELD } from "./rows";
import { t, useT } from "../../lib/i18n";
import type { FooterContext } from "./types";

type ProviderLoad =
  | { status: "loading" }
  | { status: "loaded"; snapshot: ProviderKeysSnapshot }
  | { status: "error"; message: string };

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

export function ProvidersPage({ projectCwd }: { projectCwd: string | null }) {
  const t = useT();
  const readProviderKeys = useStore((s) => s.readProviderKeys);
  const setProviderKey = useStore((s) => s.setProviderKey);
  const clearProviderKey = useStore((s) => s.clearProviderKey);

  const [load, setLoad] = useState<ProviderLoad>({ status: "loading" });
  /** env name of the row with a write in flight; its controls stay disabled. */
  const [pendingEnv, setPendingEnv] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const gen = useRef(0);

  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    readProviderKeys(projectCwd).then(
      (snapshot) => {
        if (g === gen.current) setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => {
        if (g === gen.current)
          setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [readProviderKeys, projectCwd]);

  /** Every write answers with the refreshed snapshot, so no re-read is needed. */
  const run = (envName: string, op: Promise<ProviderKeysSnapshot>): void => {
    setPendingEnv(envName);
    op.then(
      (snapshot) => {
        setWriteError(null);
        setLoad({ status: "loaded", snapshot });
      },
      (err: unknown) => setWriteError(displayMessage(err)),
    ).finally(() => setPendingEnv(null));
  };

  if (load.status === "loading") {
    return <Empty title={t("settings.providers.reading")} />;
  }
  if (load.status === "error") {
    return <Empty title={t("settings.providers.readFailed")} hint={load.message} />;
  }

  const { providers, encryptionAvailable, backend } = load.snapshot;
  const configured = providers.filter((p) => p.source !== "none");
  const groups: ReadonlyArray<{
    id: ProviderKeyStatus["group"];
    label: string;
  }> = [
    { id: "models", label: t("settings.providers.modelProviders") },
    { id: "search", label: t("settings.providers.webSearch") },
  ];

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Dot tone={configured.length > 0 ? "signal" : "copper"} />
          <p className="text-xs font-medium text-ink">
            {configured.length === 0
              ? t("settings.providers.noneConfigured")
              : t("settings.providers.someConfigured", {
                  configured: configured.length,
                  total: providers.length,
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

      {writeError !== null && (
        <p className="text-[11px] leading-relaxed text-rose">{writeError}</p>
      )}

      {groups.map(({ id, label }) => {
        const rows = providers.filter((p) => p.group === id);
        if (rows.length === 0) return null;
        return (
          <div key={id} className="space-y-0.5">
            <Label>{label}</Label>
            <div className="divide-y divide-line-soft">
              {rows.map((row) => (
                <ProviderRow
                  key={row.id}
                  row={row}
                  busy={pendingEnv !== null}
                  onSave={(value) =>
                    run(row.env, setProviderKey(row.env, value))
                  }
                  onClear={() => run(row.env, clearProviderKey(row.activeEnv))}
                />
              ))}
            </div>
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
    </p>
  );
}
