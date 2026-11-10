import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CouncilDocument,
  CouncilMember,
  CouncilRosterView,
  CouncilWriteRequest,
  ModelCatalogSnapshot,
} from "@omp-ui/core/types";
import { parseModelRole } from "@omp-ui/core/model-role";
import { councilMemberSlug, councilNameFromModel, MAX_COUNCIL_MEMBERS, MAX_COUNCIL_NAME } from "@omp-ui/core/council";
import { backendFor, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { ModelInfo } from "../lib/rpc-types";
import { findInstance, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, Label, Panel, Switch } from "./ui";

/**
 * The Council roster (ADR-0088, issue #1049). `CouncilRosterEditor` edits app
 * state — this project's `councilRoster`, or the global one — and applies on
 * session relaunch: `/council` asks the first MAX_COUNCIL_MEMBERS enabled
 * members plus the trial member when one is set, each pinned to its own
 * model, so running sessions keep the council they were launched with. Every
 * member needs a model; nothing falls back to the session model.
 */

type Load = { status: "loading" } | { status: "loaded"; result: CouncilRosterView } | { status: "error"; message: string };
type CouncilScope = CouncilWriteRequest["scope"];
type ChatCatalogLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; snapshot: ModelCatalogSnapshot };

function useRosterLoad(scopeCwd: string | null, instanceId: string | null): [Load, (r: CouncilRosterView) => void, () => void] {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const mine = ++gen.current;
    setLoad({ status: "loading" });
    backendFor(instanceId)
      .getCouncilRoster(scopeCwd)
      .then(
        (result) => {
          if (gen.current === mine) setLoad({ status: "loaded", result });
        },
        (err: unknown) => {
          if (gen.current === mine) setLoad({ status: "error", message: displayMessage(err) });
        },
      );
  }, [scopeCwd, instanceId, retry]);
  return [load, (result) => setLoad({ status: "loaded", result }), () => setRetry((n) => n + 1)];
}

const EMPTY_MODELS: ModelInfo[] = [];

function blankEntry(): CouncilMember {
  return { name: "", model: null, instructions: null, enabled: true };
}

/** A launchable model selector: present and shaped `provider/id[:level]`. */
function modelOk(value: string | null): boolean {
  if (value === null) return false;
  const parsed = parseModelRole(value);
  return parsed !== null && parsed.model !== "";
}

const canonical = (d: CouncilDocument): string =>
  JSON.stringify({ instructions: d.instructions, members: d.members, trial: d.trial ?? null });
const documentsEqual = (a: CouncilDocument, b: CouncilDocument): boolean => canonical(a) === canonical(b);

const inputClass =
  "w-full rounded border border-line bg-void px-2 py-1 font-mono text-xs text-ink outline-none focus:border-line-strong disabled:opacity-60";

/** One roster row: name, enabled, model (typed or picked), instructions. */
function MemberPanel({
  member,
  canPick,
  onChange,
  onRemove,
  onPick,
}: {
  member: CouncilMember;
  canPick: boolean;
  onChange: (patch: Partial<CouncilMember>) => void;
  onRemove: () => void;
  onPick: () => void;
}) {
  const t = useT();
  return (
    <Panel className="flex flex-col gap-2 p-2.5">
      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          placeholder={
            member.name.trim() === "" && modelOk(member.model)
              ? councilNameFromModel(member.model) ?? t("council.roster.namePlaceholder")
              : t("council.roster.namePlaceholder")
          }
          aria-label={t("council.roster.colName")}
          value={member.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <Switch on={member.enabled} label={t("council.roster.enabled")} onChange={(next) => onChange({ enabled: next })} />
        <Button size="xs" variant="ghost" tone="rose" onClick={onRemove}>
          {t("council.roster.remove")}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          placeholder={t("council.roster.modelPlaceholder")}
          aria-label={t("council.roster.colModel")}
          value={member.model ?? ""}
          onChange={(e) => onChange({ model: e.target.value === "" ? null : e.target.value })}
        />
        {canPick && (
          <Button size="xs" onClick={onPick}>
            {t("council.roster.pick")}
          </Button>
        )}
      </div>
      {!modelOk(member.model) && <p className="text-xs text-rose">{t("council.roster.modelRequired")}</p>}
      <textarea
        className={cn(inputClass, "h-14")}
        aria-label={t("council.roster.instructions")}
        placeholder={t("council.roster.instructions")}
        value={member.instructions ?? ""}
        onChange={(e) => onChange({ instructions: e.target.value === "" ? null : e.target.value })}
      />
    </Panel>
  );
}

export function CouncilRosterEditor({ scopeCwd, instanceId }: { scopeCwd: string | null; instanceId: string | null }) {
  const t = useT();
  const [scope, setScope] = useState<CouncilScope>(scopeCwd === null ? "user" : "project");
  const [load, setLoad, reload] = useRosterLoad(scopeCwd, instanceId);
  const [draft, setDraft] = useState<CouncilDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickTarget, setPickTarget] = useState<number | "trial" | null>(null);
  const [catalog, setCatalog] = useState<ChatCatalogLoad>({ status: "idle" });
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const restartSession = useStore((s) => s.restartSession);
  const readChatModels = useStore((s) => s.readChatModels);

  // The document the edited scope holds in app state; null = unset.
  const stored = useMemo(
    () => (load.status === "loaded" ? (scope === "project" ? load.result.project : load.result.global) : null),
    [load, scope],
  );

  // What the editor seeds from: the scope's own document, else the global
  // document it inherits (editing it creates the override), else empty. The
  // fallback reads the stored document, not `effective` — effective carries
  // #1057's derived names, and copying those into a new override would pin
  // what should keep following each member's model. Memoized on the load: a
  // fresh object per render would re-seed the draft under the user's
  // keystrokes.
  const seed = useMemo((): CouncilDocument | null => {
    if (load.status !== "loaded") return null;
    const own = scope === "project" ? load.result.project : load.result.global;
    if (own !== null) return structuredClone(own);
    if (load.result.global !== null) return structuredClone(load.result.global);
    return { instructions: null, members: [] };
  }, [load, scope]);

  // Seed the draft from the loaded state whenever the view (not the draft) changes.
  useEffect(() => {
    if (seed) {
      setDraft(structuredClone(seed));
      setDirty(false);
    } else setDraft(null);
  }, [seed]);

  // A remote project's picker lists a live session's catalog (the remote's
  // omp, not this host's); a local project reads omp's chat catalog on demand.
  const liveModels = useMemo(() => {
    if (instanceId === null || scopeCwd === null) return EMPTY_MODELS;
    const group = findInstance(state, instanceId)?.projects.find((g) => g.project.path === scopeCwd);
    for (const session of group?.sessions ?? []) {
      if (session.live !== "live") continue;
      const list = rpc[session.tabId]?.availableModels;
      if (list !== undefined && list.length > 0) return list;
    }
    return EMPTY_MODELS;
  }, [state, rpc, scopeCwd, instanceId]);

  const liveSessions = useMemo(() => {
    if (scopeCwd === null) return [];
    const groups = instanceId === null ? state?.projects : findInstance(state, instanceId)?.projects;
    const group = groups?.find((g) => g.project.path === scopeCwd);
    return (group?.sessions ?? []).filter((s) => s.live === "live" && s.mode === "rpc-ui");
  }, [state, scopeCwd, instanceId]);

  if (load.status === "loading") return <p className="px-4 py-3 text-xs text-ink-faint">{t("council.roster.loading")}</p>;
  if (load.status === "error") {
    return (
      <div className="px-4 py-3 text-xs">
        <p className="text-rose">{load.message}</p>
        <Button size="xs" onClick={reload}>
          {t("council.roster.reload")}
        </Button>
      </div>
    );
  }
  const result = load.result;
  if (seed === null || draft === null) return null;

  const update = (patch: Partial<CouncilDocument>): void => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setSaved(false);
  };
  const updateEntry = (i: number, patch: Partial<CouncilMember>): void =>
    update({ members: draft.members.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const trial = draft.trial ?? null;
  const updateTrial = (patch: Partial<CouncilMember>): void =>
    update({ trial: { ...(trial ?? blankEntry()), ...patch } });
  const canPick = instanceId === null || liveModels.length > 0;

  /** Opens the picker; a local project probes omp's chat catalog once per mount. */
  const pick = (target: number | "trial"): void => {
    setPickTarget(target);
    if (instanceId !== null || catalog.status !== "idle") return;
    setCatalog({ status: "loading" });
    readChatModels().then(
      (snapshot) => setCatalog({ status: "loaded", snapshot }),
      (err: unknown) =>
        setCatalog({ status: "loaded", snapshot: { models: [], discovered: false, error: displayMessage(err) } }),
    );
  };

  // A blank name is never an error (#1057): it stays blank in storage and the
  // validator derives it from the model, suffixing any collision. Only a
  // hand-typed name is checked here — pattern, length, and duplicates against
  // another hand-typed name; every member still needs a launchable model.
  const rows = trial === null ? draft.members : [...draft.members, trial];
  const typedSlugs = rows.map((m) => (m.name.trim() === "" ? null : councilMemberSlug(m.name)));
  const invalid = rows.some(
    (m, i) =>
      !modelOk(m.model) ||
      (typedSlugs[i] !== null &&
        (typedSlugs[i] === "" || typedSlugs[i]!.length > MAX_COUNCIL_NAME || typedSlugs.indexOf(typedSlugs[i]) !== i)),
  );
  const full = draft.members.length >= MAX_COUNCIL_MEMBERS;
  const paletteModels = instanceId === null
    ? catalog.status === "loaded" && catalog.snapshot.discovered
      ? catalog.snapshot.models
      : null
    : liveModels;

  // The whole document (or null to clear the scope); a project draft identical
  // to the global document is a clear — the same council either way, and the
  // chain stays readable.
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const clean = (m: CouncilMember): CouncilMember => ({
        // A blank name stays blank (#1057): the validator derives it from the
        // member's current model, so switching models renames the member.
        ...m,
        name: m.name.trim(),
        model: m.model?.trim() ? m.model.trim() : null,
      });
      const doc: CouncilDocument = {
        instructions: draft.instructions?.trim() ? draft.instructions : null,
        members: draft.members.map(clean),
        // An empty slot is an absent key: the document then matches one saved
        // before the slot existed, which an older joined instance still accepts.
        ...(trial === null ? {} : { trial: clean(trial) }),
      };
      const clear =
        scope === "project" &&
        result.global !== null &&
        documentsEqual(doc, result.global);
      const next = await backendFor(instanceId).setCouncilRoster({
        scopeCwd: scope === "project" ? scopeCwd : null,
        scope,
        document: clear ? null : doc,
      });
      setLoad(next);
      setSaved(true);
    } catch (err) {
      setError(displayMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /** Drops the project override so the global council (or none) applies again. */
  const clearOverride = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next = await backendFor(instanceId).setCouncilRoster({ scopeCwd, scope: "project", document: null });
      setLoad(next);
      setSaved(true);
    } catch (err) {
      setError(displayMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-xs" data-testid="council-roster-editor">
      <p className="text-xs leading-relaxed text-ink-faint">{t("council.roster.explain")}</p>
      {scopeCwd !== null && (
        <div className="flex items-center gap-2">
          <Button size="xs" selected={scope === "project"} onClick={() => setScope("project")}>
            {t("council.roster.scopeProject")}
          </Button>
          <Button size="xs" selected={scope === "user"} onClick={() => setScope("user")}>
            {t("council.roster.scopeUser")}
          </Button>
        </div>
      )}
      {scope === "project" && stored === null && (
        <p className="text-ink-faint">{t("council.roster.inheritGlobal")}</p>
      )}

      <div>
        <Label>{t("council.roster.sharedInstructions")}</Label>
        <textarea
          className={cn(inputClass, "mt-1 h-16")}
          aria-label={t("council.roster.sharedInstructions")}
          value={draft.instructions ?? ""}
          onChange={(e) => update({ instructions: e.target.value === "" ? null : e.target.value })}
        />
      </div>

      {draft.members.map((m, i) => (
        <MemberPanel
          key={i}
          member={m}
          canPick={canPick}
          onChange={(patch) => updateEntry(i, patch)}
          onRemove={() => update({ members: draft.members.filter((_, j) => j !== i) })}
          onPick={() => pick(i)}
        />
      ))}

      <div>
        <Button
          size="xs"
          disabled={full}
          title={full ? t("council.roster.full") : undefined}
          onClick={() => update({ members: [...draft.members, blankEntry()] })}
        >
          {t("council.roster.add")}
        </Button>
      </div>

      <div className="flex flex-col gap-2" data-testid="council-trial">
        <Label>{t("council.roster.trialTitle")}</Label>
        <p className="text-xs leading-relaxed text-ink-faint">{t("council.roster.trialHint")}</p>
        {trial === null ? (
          <div>
            <Button size="xs" onClick={() => update({ trial: blankEntry() })}>
              {t("council.roster.trialAdd")}
            </Button>
          </div>
        ) : (
          <MemberPanel
            member={trial}
            canPick={canPick}
            onChange={updateTrial}
            onRemove={() => update({ trial: null })}
            onPick={() => pick("trial")}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="flex-1" />
        {scope === "project" && stored !== null && (
          <Button
            size="xs"
            variant="ghost"
            tone="rose"
            disabled={saving}
            onClick={() => void clearOverride()}
          >
            {t("council.roster.clearOverride")}
          </Button>
        )}
        <Button
          size="xs"
          disabled={!dirty}
          onClick={() => {
            setDraft(structuredClone(seed));
            setDirty(false);
            setError(null);
          }}
        >
          {t("council.roster.discard")}
        </Button>
        <Button size="xs" variant="solid" disabled={!dirty || invalid || saving} onClick={() => void save()}>
          {t("council.roster.save")}
        </Button>
      </div>
      {error !== null && (
        <div className="flex items-center gap-2 text-rose">
          <span className="break-words">{error}</span>
          <Button size="xs" onClick={reload}>
            {t("council.roster.reload")}
          </Button>
        </div>
      )}
      {saved && (
        <Panel className="p-2">
          <p>{t("council.roster.applyOnRelaunch")}</p>
          {liveSessions.map((s) => (
            <div key={s.tabId} className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate">{s.title}</span>
              <Button size="xs" onClick={() => void restartSession(s.tabId)}>
                {t("council.roster.restart")}
              </Button>
            </div>
          ))}
        </Panel>
      )}
      {result.configWarnings.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-copper">
          {result.configWarnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Label>{t("council.roster.effective")}</Label>
        {result.effective.length === 0 && result.effectiveTrial == null ? (
          <p className="text-ink-faint">{t("council.roster.effectiveNone")}</p>
        ) : (
          <ul className="mt-1 font-mono text-xs text-ink-mid">
            {result.effective.map((e) => (
              <li key={`${e.sourceScope}:${e.name}`} className="break-all">
                {e.name} · {e.enabled ? "on" : "off"} · {e.model ?? t("council.roster.noModel")} ·{" "}
                {e.sourceScope === "project" ? t("council.roster.scopeProject") : t("council.roster.scopeUser")}
              </li>
            ))}
            {result.effectiveTrial != null && (
              <li key="trial" className="break-all">
                {result.effectiveTrial.name} · {t("council.roster.trialTag")} ·{" "}
                {result.effectiveTrial.enabled ? "on" : "off"} ·{" "}
                {result.effectiveTrial.model ?? t("council.roster.noModel")} ·{" "}
                {result.effectiveTrial.sourceScope === "project"
                  ? t("council.roster.scopeProject")
                  : t("council.roster.scopeUser")}
              </li>
            )}
          </ul>
        )}
      </div>

      {pickTarget !== null && instanceId === null && catalog.status === "loading" && (
        <p className="text-ink-faint">{t("council.roster.catalogLoading")}</p>
      )}
      {pickTarget !== null && instanceId === null && catalog.status === "loaded" && !catalog.snapshot.discovered && (
        <p className="text-ink-faint">
          {t("settings.omp.modelRoleCatalogFailed", { message: catalog.snapshot.error ?? "" })}
        </p>
      )}
      {pickTarget !== null && paletteModels !== null && (
        <ModelPalette
          variant="subagent"
          models={paletteModels}
          current={pickTarget === "trial" ? trial?.model ?? null : draft.members[pickTarget]?.model ?? null}
          allowInherit={false}
          instanceId={instanceId}
          onClose={() => setPickTarget(null)}
          onPick={(selector) => {
            const target = pickTarget;
            setPickTarget(null);
            if (target === "trial") updateTrial({ model: selector });
            else updateEntry(target, { model: selector });
          }}
        />
      )}
    </div>
  );
}
