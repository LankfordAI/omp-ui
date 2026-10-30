import { useState } from "react";
import type { RemoteInstanceInput, RemoteInstanceSummary } from "@omp-ui/core/types";
import { FLEET_RUNGS, type FleetGrantRaiseOutcome, type FleetGrantRecord, type FleetRung } from "@omp-ui/core/fleet";
import { defaultNickname, normalizeInstanceUrl } from "@omp-ui/core/remote-instances";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useT, type MessageKey } from "../../lib/i18n";
import { remoteInstanceStatusKey, remoteInstanceStatusTone } from "../../lib/remote-instance-status";
import { useStore } from "../../store";
import { Button, Chip, ChoiceCapsule, Dot, Empty, Label, Panel, Switch } from "../ui";
import { CommitField, FIELD, Row, SecretField } from "./rows";

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
        <div className="flex flex-wrap items-center gap-1.5">
          <SecretKindCapsule value={secretKind} onChange={setSecretKind} />
          <SecretField
            value={secret}
            label={
              secretKind === "token"
                ? t("remoteinstances.field.token")
                : t("remoteinstances.field.password")
            }
            className="min-w-[8rem] flex-1 basis-40"
            onChange={setSecret}
            onSave={saveSecret}
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
  const refreshRemoteInstanceState = useStore((s) => s.refreshRemoteInstanceState);
  const confirmRemoveRemoteInstance = useStore((s) => s.confirmRemoveRemoteInstance);
  const [editing, setEditing] = useState(false);
  const [requesting, setRequesting] = useState(false);

  return (
    <Panel className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Dot
              tone={remoteInstanceStatusTone(instance.status)}
              pulse={instance.status === "connecting"}
            />
            <p className="max-w-full min-w-0 truncate text-xs font-medium text-ink">
              {instance.nickname}
            </p>
            <span className="shrink-0 text-[11px] text-ink-dim">
              {t(remoteInstanceStatusKey(instance.status))}
            </span>
            {instance.version !== null && (
              <Chip
                mono
                truncate
                className="max-w-[12rem]"
                title={t("remoteinstances.page.version", { version: instance.version })}
              >
                {t("remoteinstances.page.version", { version: instance.version })}
              </Chip>
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
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button size="xs" onClick={() => void reconnectRemoteInstance(instance.id)}>
            {t("remoteinstances.action.reconnect")}
          </Button>
          {instance.status === "joined" && (
            <>
              {/* Re-reads the member's session list (#658); this panel is its
                  only home since the sidebar's instance group header went. */}
              <Button size="xs" variant="ghost" onClick={() => void refreshRemoteInstanceState(instance.id)}>
                {t("remoteinstances.action.refreshState")}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setRequesting((v) => !v)}>
                {t("settings.remoteinstances.grant.request")}
              </Button>
            </>
          )}
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
      {requesting && <GrantCeremony instance={instance} onDone={() => setRequesting(false)} />}
      {editing && <InstanceEditor instance={instance} />}
    </Panel>
  );
}

/** The five ladder rungs, ladder order; labels ride the Fleet view's keys. */
const RUNG_LABEL: Record<FleetRung, MessageKey> = {
  observe: "fleet.rung.observe",
  dispatch: "fleet.rung.dispatch",
  manage: "fleet.rung.manage",
  full: "fleet.rung.full",
  terminal: "fleet.rung.terminal",
};

/** What a manager can ask a member for: the rungs above the join default. */
const RAISE_RUNGS = ["manage", "full", "terminal"] as const satisfies readonly FleetRung[];

/**
 * The re-presentation ceremony (issue #901), manager side: asking a joined
 * member for more access re-types THAT member's join secret, which rides once
 * to its own fleet:grantRaise and is never stored or prefilled. The member
 * decides (credential, ceiling); its answer renders inline — a wrong secret
 * is an explanation, not an error notice.
 */
function GrantCeremony({ instance, onDone }: { instance: RemoteInstanceSummary; onDone: () => void }) {
  const t = useT();
  const requestFleetGrant = useStore((s) => s.requestFleetGrant);
  const [rung, setRung] = useState<(typeof RAISE_RUNGS)[number]>("manage");
  const [secretKind, setSecretKind] = useState<SecretKind>("password");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<FleetGrantRaiseOutcome | null>(null);

  const submit = (): void => {
    const value = secret.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setSecret("");
    // Password and token both ride the one `credential` field: the member
    // tries every verifier it holds (token, session credential, password).
    void requestFleetGrant(instance.id, rung, value)
      .then(setOutcome)
      .catch((err: unknown) => setOutcome({ ok: false, reason: displayMessage(err) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-3 space-y-2 border-t border-line-soft pt-3">
      <p className="text-[11px] leading-relaxed text-ink-faint">
        {t("settings.remoteinstances.grant.ceremony", { machine: instance.nickname })}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceCapsule
          label={t("settings.remoteinstances.grant.cap", { machine: instance.nickname })}
          value={rung}
          options={RAISE_RUNGS.map((r) => ({ value: r, label: t(RUNG_LABEL[r]) }))}
          onChange={setRung}
          optionClassName="px-2 text-[11px]"
        />
        <SecretKindCapsule value={secretKind} onChange={setSecretKind} />
        <SecretField
          value={secret}
          label={secretKind === "token" ? t("remoteinstances.field.token") : t("remoteinstances.field.password")}
          disabled={busy}
          className="min-w-[8rem] flex-1 basis-40"
          onChange={setSecret}
          onSave={submit}
        />
        <Button size="xs" variant="solid" disabled={secret.trim() === "" || busy} onClick={submit}>
          {busy ? t("settings.remoteinstances.grant.raising") : t("settings.remoteinstances.grant.raise")}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDone}>
          {t("remoteinstances.action.cancel")}
        </Button>
      </div>
      {outcome !== null && (
        <p
          role={outcome.ok ? undefined : "alert"}
          className={cn("text-[11px] leading-relaxed", outcome.ok ? "text-ink-mid" : "text-rose")}
        >
          {outcome.ok
            ? t("settings.remoteinstances.grant.granted", { rung: t(RUNG_LABEL[outcome.rung]) })
            : t("settings.remoteinstances.grant.refused", { reason: outcome.reason })}
        </p>
      )}
    </div>
  );
}

/**
 * One dispatcher this machine has heard from (node side, issue #901): its
 * stored rung or the join default, editable here without a secret — the owner
 * at this machine is the authority. Reset drops the record back to Dispatch.
 */
function DispatcherGrantRow({ dispatcherId, record }: { dispatcherId: string; record: FleetGrantRecord }) {
  const t = useT();
  const ceiling = useStore((s) => s.state?.fleetExecCeiling ?? "dispatch");
  const setFleetGrant = useStore((s) => s.setFleetGrant);
  const name = record.label === "" ? dispatcherId : record.label;
  const held: FleetRung = record.rung ?? "dispatch";
  const effective = FLEET_RUNGS[Math.min(FLEET_RUNGS.indexOf(held), FLEET_RUNGS.indexOf(ceiling))]!;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2" data-dispatcher-id={dispatcherId}>
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-xs text-ink" title={dispatcherId}>
          {name}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
          {record.rung === undefined
            ? t("settings.remoteinstances.grant.defaulted", { rung: t(RUNG_LABEL[held]) })
            : effective === held
              ? t("settings.remoteinstances.grant.stored", { rung: t(RUNG_LABEL[held]) })
              : t("settings.remoteinstances.grant.capped", { rung: t(RUNG_LABEL[held]), effective: t(RUNG_LABEL[effective]) })}
        </p>
      </div>
      <ChoiceCapsule
        label={t("settings.remoteinstances.grant.cap", { machine: name })}
        value={held}
        options={FLEET_RUNGS.map((rung) => ({ value: rung, label: t(RUNG_LABEL[rung]) }))}
        onChange={(rung) => void setFleetGrant(dispatcherId, rung)}
        optionClassName="px-2 text-[11px]"
      />
      <Button size="xs" variant="ghost" disabled={record.rung === undefined} onClick={() => void setFleetGrant(dispatcherId, null)}>
        {t("settings.remoteinstances.grant.reset")}
      </Button>
    </div>
  );
}

/**
 * Fleet access (issue #901), this machine as a member: the exec master
 * switch, the ceiling every grant bows to, the declared clone/register roots,
 * and one row per dispatcher that has reached this machine.
 */
function FleetAccessSection() {
  const t = useT();
  const execEnabled = useStore((s) => s.state?.fleetExecEnabled === true);
  const ceiling = useStore((s) => s.state?.fleetExecCeiling ?? "dispatch");
  const roots = useStore((s) => s.state?.fleetProjectRoots ?? []);
  const grants = useStore((s) => s.state?.fleetGrants ?? null);
  const setFleetExecEnabled = useStore((s) => s.setFleetExecEnabled);
  const setFleetExecCeiling = useStore((s) => s.setFleetExecCeiling);
  const setFleetProjectRoots = useStore((s) => s.setFleetProjectRoots);
  const [draftRoot, setDraftRoot] = useState("");

  const addRoot = (): void => {
    const value = draftRoot.trim();
    if (value === "") return;
    setDraftRoot("");
    void setFleetProjectRoots([...roots, value]);
  };

  return (
    <div className="space-y-1">
      <Row title={t("settings.remoteinstances.execTitle")} hint={t("settings.remoteinstances.execHint")}>
        <Switch
          on={execEnabled}
          onChange={(next) => void setFleetExecEnabled(next)}
          label={t("settings.remoteinstances.execTitle")}
        />
      </Row>
      <Row title={t("settings.remoteinstances.ceilingTitle")} hint={t("settings.remoteinstances.ceilingHint")}>
        <ChoiceCapsule
          label={t("settings.remoteinstances.ceilingTitle")}
          value={ceiling}
          options={FLEET_RUNGS.map((rung) => ({ value: rung, label: t(RUNG_LABEL[rung]) }))}
          onChange={(rung) => void setFleetExecCeiling(rung)}
          optionClassName="px-2 text-[11px]"
        />
      </Row>
      <div className="py-2">
        <Label>{t("settings.remoteinstances.rootsTitle")}</Label>
        <p className="mb-1.5 text-[11px] leading-relaxed text-ink-faint">{t("settings.remoteinstances.rootsHint")}</p>
        {roots.length === 0 && (
          <p className="text-[11px] text-ink-dim">{t("settings.remoteinstances.roots.empty")}</p>
        )}
        <ul className="space-y-1">
          {roots.map((root) => (
            <li key={root} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-mid" title={root}>
                {root}
              </code>
              <Button
                size="xs"
                variant="ghost"
                tone="rose"
                onClick={() => void setFleetProjectRoots(roots.filter((r) => r !== root))}
              >
                {t("settings.remoteinstances.roots.remove")}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            value={draftRoot}
            spellCheck={false}
            placeholder="/srv/repos"
            aria-label={t("settings.remoteinstances.rootsTitle")}
            className={cn(FIELD, "flex-1")}
            onChange={(e) => setDraftRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRoot();
              }
            }}
          />
          <Button size="xs" disabled={draftRoot.trim() === ""} onClick={addRoot}>
            {t("settings.remoteinstances.roots.add")}
          </Button>
        </div>
      </div>
      <Label>{t("settings.remoteinstances.grantTitle")}</Label>
      {grants !== null && Object.keys(grants).length === 0 && (
        <p className="py-2 text-[11px] text-ink-dim">{t("settings.remoteinstances.grant.empty")}</p>
      )}
      {grants !== null && Object.keys(grants).length > 0 && (
        <div className="divide-y divide-line-soft">
          {Object.entries(grants).map(([dispatcherId, record]) => (
            <DispatcherGrantRow key={dispatcherId} dispatcherId={dispatcherId} record={record} />
          ))}
        </div>
      )}
    </div>
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
            <SecretField
              value={secret}
              label={
                secretKind === "token"
                  ? t("remoteinstances.field.token")
                  : t("remoteinstances.field.password")
              }
              disabled={busy}
              className="flex-1"
              onChange={setSecret}
              onSave={submit}
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
  const fleetAgentDispatch = useStore((s) => s.state?.fleetAgentDispatch === true);
  const setFleetAgentDispatch = useStore((s) => s.setFleetAgentDispatch);
  const remoteVsCodeEnabled = useStore((s) => s.state?.remoteVsCodeEnabled === true);
  const setRemoteVsCodeEnabled = useStore((s) => s.setRemoteVsCodeEnabled);

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
      <Row
        title={t("settings.remoteinstances.fleetAgentTitle")}
        hint={t("settings.remoteinstances.fleetAgentHint")}
      >
        <Switch
          on={fleetAgentDispatch}
          onChange={(next) => void setFleetAgentDispatch(next)}
          label={t("settings.remoteinstances.fleetAgentTitle")}
        />
      </Row>
      <Row title={t("settings.remoteinstances.vsCodeTitle")} hint={t("settings.remoteinstances.vsCodeHint")}>
        <Switch
          on={remoteVsCodeEnabled}
          onChange={(next) => void setRemoteVsCodeEnabled(next)}
          label={t("settings.remoteinstances.vsCodeTitle")}
        />
      </Row>
      <div>
        <Label>{t("settings.remoteinstances.fleetAccessTitle")}</Label>
        <FleetAccessSection />
      </div>
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
