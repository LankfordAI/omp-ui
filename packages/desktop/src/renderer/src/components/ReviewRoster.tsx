import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ReviewDocument,
  ReviewFileView,
  ReviewReviewer,
  ReviewRosterView,
  ReviewTargetKind,
} from "@omp-ui/core/types";
import { parseModelRole } from "@omp-ui/core/model-role";
import { reviewerSlug } from "@omp-ui/core/review";
import { backendFor, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import type { ModelInfo } from "../lib/rpc-types";
import { findInstance, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, Label, Panel, Switch } from "./ui";

/**
 * The reviewer roster (issue #728, ADR-0047). `ReviewRosterEditor` edits file
 * truth — REVIEW.yml at the user or project scope — and applies on session
 * relaunch: `/code-review` launches the enabled entries as background review
 * agents, so running sessions keep the roster they were launched with.
 */

type Load = { status: "loading" } | { status: "loaded"; result: ReviewRosterView } | { status: "error"; message: string };
type ReviewScope = "user" | "project";

const TARGET_KINDS: readonly ReviewTargetKind[] = ["local", "commit", "pr"];

function useRosterLoad(scopeCwd: string | null, instanceId: string | null): [Load, (r: ReviewRosterView) => void, () => void] {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    backendFor(instanceId).getReviewRoster(scopeCwd).then(
      (result) => {
        if (g === gen.current) setLoad({ status: "loaded", result });
      },
      (err: unknown) => {
        if (g === gen.current) setLoad({ status: "error", message: displayMessage(err) });
      },
    );
  }, [scopeCwd, instanceId, retry]);
  return [load, (result) => setLoad({ status: "loaded", result }), () => setRetry((n) => n + 1)];
}

const EMPTY_MODELS: ModelInfo[] = [];

function blankEntry(): ReviewReviewer {
  return { name: "", model: null, instructions: null, targets: null, enabled: true };
}

function modelShapeOk(value: string): boolean {
  const role = parseModelRole(value);
  return role !== null && role.model.includes("/");
}

const inputClass =
  "w-full rounded border border-line bg-void px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-line-strong disabled:opacity-60";

export function ReviewRosterEditor({ scopeCwd, instanceId }: { scopeCwd: string | null; instanceId: string | null }) {
  const t = useT();
  const [scope, setScope] = useState<ReviewScope>(scopeCwd === null ? "user" : "project");
  const [load, setLoad, reload] = useRosterLoad(scopeCwd, instanceId);
  const [draft, setDraft] = useState<ReviewDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const restartSession = useStore((s) => s.restartSession);

  const view: ReviewFileView | null =
    load.status === "loaded" ? (scope === "project" ? load.result.project : load.result.user) : null;

  // Seed the draft from the loaded file whenever the view (not the draft) changes.
  useEffect(() => {
    if (view) {
      setDraft(structuredClone(view.document));
      setDirty(false);
    } else setDraft(null);
  }, [view]);

  const models = useMemo(() => {
    if (scopeCwd === null) return EMPTY_MODELS;
    const groups = instanceId === null ? state?.projects : findInstance(state, instanceId)?.projects;
    const group = groups?.find((g) => g.project.path === scopeCwd);
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

  if (load.status === "loading") return <p className="px-4 py-3 text-xs text-ink-faint">{t("review.roster.loading")}</p>;
  if (load.status === "error") {
    return (
      <div className="px-4 py-3 text-xs">
        <p className="text-rose">{load.message}</p>
        <Button size="xs" onClick={reload}>
          {t("review.roster.reload")}
        </Button>
      </div>
    );
  }
  const result = load.result;
  if (view === null || draft === null) return null;

  const blocked = view.blocking.length > 0;
  const update = (patch: Partial<ReviewDocument>): void => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setSaved(false);
  };
  const updateEntry = (i: number, patch: Partial<ReviewReviewer>): void =>
    update({ reviewers: draft.reviewers.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  const slugs = draft.reviewers.map((r) => reviewerSlug(r.name));
  const invalid =
    draft.reviewers.some((r, i) => r.name.trim() === "" || slugs.indexOf(slugs[i]!) !== i || (r.model !== null && r.model !== "" && !modelShapeOk(r.model)));

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const doc: ReviewDocument = {
        ...draft,
        reviewers: draft.reviewers.map((r) => ({ ...r, model: r.model?.trim() ? r.model.trim() : null })),
      };
      const next = await backendFor(instanceId).setReviewRoster({
        scopeCwd: scope === "project" ? scopeCwd : null,
        scope,
        baseHash: view.hash,
        document: doc,
      });
      setLoad(next);
      setSaved(true);
    } catch (err) {
      setError(displayMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-xs" data-testid="review-roster-editor">
      <p className="text-[11px] leading-relaxed text-ink-faint">{t("review.roster.explain")}</p>
      <div className="flex items-center gap-2">
        <Button size="xs" selected={scope === "project"} disabled={scopeCwd === null} onClick={() => setScope("project")}>
          {t("review.roster.scopeProject")}
        </Button>
        <Button size="xs" selected={scope === "user"} onClick={() => setScope("user")}>
          {t("review.roster.scopeUser")}
        </Button>
        <span className="min-w-0 truncate font-mono text-[10px] text-ink-dim" title={view.path}>
          {view.path}
        </span>
      </div>
      {!view.exists && <p className="text-ink-faint">{t("review.roster.noFile")}</p>}
      {view.blocking.length > 0 && (
        <Panel tone="rose" className="p-2">
          <p className="mb-1 font-medium">{t("review.roster.blocking")}</p>
          <ul className="list-disc pl-4">
            {view.blocking.map((b, i) => (
              <li key={i} className="break-words">
                {b}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div>
        <Label>{t("review.roster.sharedInstructions")}</Label>
        <textarea
          className={cn(inputClass, "mt-1 h-16")}
          aria-label={t("review.roster.sharedInstructions")}
          disabled={blocked}
          value={draft.instructions ?? ""}
          onChange={(e) => update({ instructions: e.target.value === "" ? null : e.target.value })}
        />
      </div>

      {draft.reviewers.map((r, i) => (
        <Panel key={i} className="flex flex-col gap-2 p-2.5">
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              placeholder={t("review.roster.namePlaceholder")}
              aria-label={t("review.roster.colName")}
              disabled={blocked}
              value={r.name}
              onChange={(e) => updateEntry(i, { name: e.target.value })}
            />
            <Switch
              on={r.enabled}
              label={t("review.roster.enabled")}
              disabled={blocked}
              onChange={(next) => updateEntry(i, { enabled: next })}
            />
            <Button size="xs" variant="ghost" tone="rose" disabled={blocked} onClick={() => update({ reviewers: draft.reviewers.filter((_, j) => j !== i) })}>
              {t("review.roster.remove")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              placeholder={t("review.roster.modelPlaceholder")}
              aria-label={t("review.roster.colModel")}
              disabled={blocked}
              value={r.model ?? ""}
              onChange={(e) => updateEntry(i, { model: e.target.value === "" ? null : e.target.value })}
            />
            {models.length > 0 && (
              <Button size="xs" disabled={blocked} onClick={() => setPickIndex(i)}>
                {t("review.roster.pick")}
              </Button>
            )}
          </div>
          {r.model !== null && r.model !== "" && !modelShapeOk(r.model) && (
            <p className="text-[10px] text-rose">{t("project.settings.selectorProvider")}</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="xs"
              selected={r.targets === null}
              disabled={blocked}
              onClick={() => updateEntry(i, { targets: r.targets === null ? [...TARGET_KINDS] : null })}
            >
              {t("review.roster.targetsAll")}
            </Button>
            {r.targets !== null &&
              TARGET_KINDS.map((kind) => (
                <Button
                  key={kind}
                  size="xs"
                  selected={r.targets!.includes(kind)}
                  disabled={blocked}
                  onClick={() =>
                    updateEntry(i, { targets: r.targets!.includes(kind) ? r.targets!.filter((x) => x !== kind) : [...r.targets!, kind] })
                  }
                >
                  {kind}
                </Button>
              ))}
          </div>
          <textarea
            className={cn(inputClass, "h-14")}
            aria-label={t("review.roster.instructions")}
            placeholder={t("review.roster.instructions")}
            disabled={blocked}
            value={r.instructions ?? ""}
            onChange={(e) => updateEntry(i, { instructions: e.target.value === "" ? null : e.target.value })}
          />
        </Panel>
      ))}

      <div className="flex items-center gap-2">
        <Button size="xs" disabled={blocked} onClick={() => update({ reviewers: [...draft.reviewers, blankEntry()] })}>
          {t("review.roster.add")}
        </Button>
        <span className="flex-1" />
        <Button
          size="xs"
          disabled={!dirty}
          onClick={() => {
            setDraft(structuredClone(view.document));
            setDirty(false);
            setError(null);
          }}
        >
          {t("review.roster.discard")}
        </Button>
        <Button size="xs" variant="solid" disabled={blocked || !dirty || invalid || saving} onClick={() => void save()}>
          {t("review.roster.save")}
        </Button>
      </div>
      {error !== null && (
        <div className="flex items-center gap-2 text-rose">
          <span className="break-words">{error}</span>
          <Button size="xs" onClick={reload}>
            {t("review.roster.reload")}
          </Button>
        </div>
      )}
      {saved && (
        <Panel className="p-2">
          <p>{t("review.roster.applyOnRelaunch")}</p>
          {liveSessions.map((s) => (
            <div key={s.tabId} className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate">{s.title}</span>
              <Button size="xs" onClick={() => void restartSession(s.tabId)}>
                {t("review.roster.restart")}
              </Button>
            </div>
          ))}
        </Panel>
      )}
      {result.configWarnings.length > 0 && (
        <ul className="list-disc pl-4 text-[11px] text-copper">
          {result.configWarnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Label>{t("review.roster.effective")}</Label>
        {result.effective.length === 0 ? (
          <p className="text-ink-faint">{t("review.roster.effectiveNone")}</p>
        ) : (
          <ul className="mt-1 font-mono text-[10px] text-ink-mid">
            {result.effective.map((e) => (
              <li key={`${e.sourceScope}:${e.name}`} className="break-all">
                {e.name} · {e.enabled ? "on" : "off"} · {e.model ?? t("review.roster.followsModel")} ·{" "}
                {e.targets !== null ? e.targets.join(",") : t("review.roster.targetsAll")} · {e.sourcePath}
              </li>
            ))}
          </ul>
        )}
      </div>

      {pickIndex !== null && (
        <ModelPalette
          variant="subagent"
          models={models}
          current={draft.reviewers[pickIndex]?.model ?? null}
          allowInherit={false}
          instanceId={instanceId}
          onClose={() => setPickIndex(null)}
          onPick={(selector) => {
            const i = pickIndex;
            setPickIndex(null);
            updateEntry(i, { model: selector });
          }}
        />
      )}
    </div>
  );
}
