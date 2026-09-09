import { useState } from "react";
import type { RemoteInstanceInput, RemoteInstanceSummary } from "@omp-ui/core/types";
import { defaultNickname, normalizeInstanceUrl } from "@omp-ui/core/remote-instances";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { remoteInstanceStatusKey, remoteInstanceStatusTone } from "../../lib/remote-instance-status";
import { useStore } from "../../store";
import { Button, Chip, ChoiceCapsule, Dot, Empty, Label, Panel } from "../ui";
import { CommitField, FIELD, Row } from "./rows";

/**
 * Settings → Remote instances (issue #416): every omp-ui app this one has
 * joined, one panel each, plus the join form. The page never sees a
 * credential — the secret goes to main once and comes back as a status. Add
 * rejections (bad URL, wrong password, duplicate nickname, no credential
 * store) show inline under the form because the user is mid-entry; the
 * per-instance actions report through the store's error notices instead.
 */

type SecretKind = RemoteInstanceInput["secret"]["kind"];

/** The URL field's parse, or null while the text is not yet a URL. */
function parseUrl(raw: string): { origin: string; token: string | null } | null {
  try {
    return normalizeInstanceUrl(raw);
  } catch {
    return null;
  }
}

function SecretKindCapsule({
  value,
  onChange,
}: {
  value: SecretKind;
  onChange: (kind: SecretKind) => void;
}) {
  const t = useT();
  return (
    <ChoiceCapsule
      label={t("remoteinstances.field.secretKind")}
      value={value}
      options={[
        { value: "password", label: t("remoteinstances.field.password") },
        { value: "token", label: t("remoteinstances.field.token") },
      ] as const}
      onChange={onChange}
      optionClassName="px-2 text-[11px]"
    />
  );
}

/**
 * The inline editor behind a panel's Edit button: nickname and URL commit on
 * Enter/blur like every settings field; the secret is a fresh entry that
 * saves explicitly — nothing to pre-fill, the stored credential never returns.
 */
function InstanceEditor({ instance }: { instance: RemoteInstanceSummary }) {
  const t = useT();
  const updateRemoteInstance = useStore((s) => s.updateRemoteInstance);
  const [secretKind, setSecretKind] = useState<SecretKind>("password");
  const [secret, setSecret] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const commitUrl = (raw: string): void => {
    let parsed: { origin: string; token: string | null };
    try {
      parsed = normalizeInstanceUrl(raw);
    } catch (err) {
      setUrlError(displayMessage(err));
      return;
    }
    setUrlError(null);
    // A pasted token link carries its own credential; a bare origin keeps the
    // stored one (main re-signs with it against the new address).
    void updateRemoteInstance(
      instance.id,
      parsed.token === null
        ? { url: parsed.origin }
        : { url: parsed.origin, secret: { kind: "token", value: parsed.token } },
    );
  };

  const saveSecret = (): void => {
    const value = secret.trim();
    if (value === "") return;
    setSecret("");
    void updateRemoteInstance(instance.id, { secret: { kind: secretKind, value } });
  };

  return (
    <div className="mt-3 divide-y divide-line-soft border-t border-line-soft">
      <Row title={t("remoteinstances.field.nickname")}>
        <CommitField
          current={instance.nickname}
          kind="text"
          label={t("remoteinstances.field.nickname")}
          disabled={false}
          className="w-48"
          onCommit={(raw) => void updateRemoteInstance(instance.id, { nickname: raw })}
        />
      </Row>
      <Row title={t("remoteinstances.field.url")} hint={urlError ?? undefined}>
        <CommitField
          current={instance.url}
          kind="text"
          label={t("remoteinstances.field.url")}
          disabled={false}
          className="w-64"
          onCommit={commitUrl}
        />
      </Row>
      <Row
        title={secretKind === "token" ? t("remoteinstances.field.token") : t("remoteinstances.field.password")}
        hint={t("remoteinstances.field.secretKeep")}
        stacked
      >
        <div className="flex items-center gap-1.5">
          <SecretKindCapsule value={secretKind} onChange={setSecretKind} />
          <input
            type="password"
            value={secret}
            aria-label={
              secretKind === "token" ? t("remoteinstances.field.token") : t("remoteinstances.field.password")
            }
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveSecret();
              }
            }}
            className={cn(FIELD, "flex-1")}
          />
          <Button size="xs" disabled={secret.trim() === ""} onClick={saveSecret}>
            {t("remoteinstances.action.save")}
          </Button>
        </div>
      </Row>
    </div>
  );
}

function InstancePanel({ instance }: { instance: RemoteInstanceSummary }) {
  const t = useT();
  const reconnectRemoteInstance = useStore((s) => s.reconnectRemoteInstance);
  const confirmRemoveRemoteInstance = useStore((s) => s.confirmRemoveRemoteInstance);
  const [editing, setEditing] = useState(false);

  return (
    <Panel className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Dot
              tone={remoteInstanceStatusTone(instance.status)}
              pulse={instance.status === "connecting"}
            />
            <p className="truncate text-xs font-medium text-ink">{instance.nickname}</p>
            <span className="shrink-0 text-[11px] text-ink-dim">
              {t(remoteInstanceStatusKey(instance.status))}
            </span>
            {instance.version !== null && (
              <Chip mono>{t("remoteinstances.page.version", { version: instance.version })}</Chip>
            )}
          </div>
          <p
            data-selectable
            className="mt-0.5 truncate font-mono text-[11px] text-ink-faint"
            title={instance.url}
          >
            {instance.url}
          </p>
          {instance.error !== null && (
            <p className="mt-1 text-[11px] leading-relaxed text-rose">{instance.error}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" onClick={() => void reconnectRemoteInstance(instance.id)}>
            {t("remoteinstances.action.reconnect")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? t("remoteinstances.action.cancel") : t("remoteinstances.action.edit")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            tone="rose"
            onClick={() => confirmRemoveRemoteInstance(instance.id, instance.nickname)}
          >
            {t("remoteinstances.action.remove")}
          </Button>
        </div>
      </div>
      {editing && <InstanceEditor instance={instance} />}
    </Panel>
  );
}

function AddForm() {
  const t = useT();
  const addRemoteInstance = useStore((s) => s.addRemoteInstance);
  const [url, setUrl] = useState("");
  const [nickname, setNickname] = useState("");
  const [secretKind, setSecretKind] = useState<SecretKind>("password");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseUrl(url);
  const carriedToken = parsed?.token ?? null;
  const host = defaultNickname(parsed?.origin ?? "");
  const canSubmit =
    !busy && url.trim() !== "" && (carriedToken !== null || secret.trim() !== "");

  const submit = (): void => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const input: RemoteInstanceInput = {
      url: url.trim(),
      nickname: nickname.trim(),
      secret:
        carriedToken !== null
          ? { kind: "token", value: carriedToken }
          : { kind: secretKind, value: secret.trim() },
    };
    addRemoteInstance(input)
      .then(
        () => {
          setUrl("");
          setNickname("");
          setSecret("");
          setSecretKind("password");
        },
        (err: unknown) => setError(displayMessage(err)),
      )
      .finally(() => setBusy(false));
  };

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="divide-y divide-line-soft">
      <Row title={t("remoteinstances.field.url")} hint={carriedToken !== null ? t("remoteinstances.field.urlToken") : undefined} stacked>
        <input
          type="text"
          value={url}
          aria-label={t("remoteinstances.field.url")}
          placeholder={t("remoteinstances.field.urlPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onEnter}
          className={cn(FIELD, "w-full font-mono")}
        />
      </Row>
      <Row
        title={t("remoteinstances.field.nickname")}
        hint={host === "" ? undefined : t("remoteinstances.field.nicknameHint", { host })}
      >
        <input
          type="text"
          value={nickname}
          aria-label={t("remoteinstances.field.nickname")}
          placeholder={host}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={onEnter}
          className={cn(FIELD, "w-48")}
        />
      </Row>
      {carriedToken === null && (
        <Row
          title={secretKind === "token" ? t("remoteinstances.field.token") : t("remoteinstances.field.password")}
          stacked
        >
          <div className="flex items-center gap-1.5">
            <SecretKindCapsule value={secretKind} onChange={setSecretKind} />
            <input
              type="password"
              value={secret}
              aria-label={
                secretKind === "token" ? t("remoteinstances.field.token") : t("remoteinstances.field.password")
              }
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={onEnter}
              className={cn(FIELD, "flex-1")}
            />
          </div>
        </Row>
      )}
      <div className="flex items-center gap-3 py-2.5">
        {error !== null && (
          <p role="alert" className="min-w-0 flex-1 text-[11px] leading-relaxed text-rose">
            {error}
          </p>
        )}
        <Button variant="solid" size="xs" className="ml-auto" disabled={!canSubmit} onClick={submit}>
          {busy ? t("remoteinstances.action.adding") : t("remoteinstances.action.add")}
        </Button>
      </div>
    </div>
  );
}

export function RemoteInstancesPage() {
  const t = useT();
  const instances = useStore((s) => s.state?.remoteInstances ?? null);

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-[11px] leading-relaxed text-ink-faint">{t("remoteinstances.page.intro")}</p>
      {instances !== null && instances.length === 0 && (
        <Empty title={t("remoteinstances.empty.instances")} hint={t("remoteinstances.empty.instancesHint")} />
      )}
      {instances !== null && instances.length > 0 && (
        <div className="space-y-2">
          {instances.map((instance) => (
            <InstancePanel key={instance.id} instance={instance} />
          ))}
        </div>
      )}
      <div>
        <Label>{t("remoteinstances.action.add")}</Label>
        <AddForm />
      </div>
    </div>
  );
}

export function RemoteInstancesFooter() {
  const t = useT();
  return <p>{t("remoteinstances.page.footer")}</p>;
}
