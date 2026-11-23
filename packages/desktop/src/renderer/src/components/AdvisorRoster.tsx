import { useEffect, useMemo, useRef, useState } from "react";
import type { AdvisorMemberStatus } from "@omp-ui/core/advisor-stats";
import type {
  WatchdogAdvisorEntry,
  WatchdogDocument,
  WatchdogFileView,
  WatchdogRosterResult,
  WatchdogScope,
} from "@omp-ui/core/types";
import {
  WATCHDOG_DEFAULT_TOOLS,
  WATCHDOG_KNOWN_TOOLS,
  WATCHDOG_MUTATING_TOOLS,
  advisorSlug,
} from "@omp-ui/core/watchdog";
import { parseModelRole } from "@omp-ui/core/model-role";
import { backendFor, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { compactNum, formatCost } from "../lib/format";
import type { ModelInfo } from "../lib/rpc-types";
import { findInstance, useStore } from "../store";
import { ModelPalette } from "./ModelSelector";
import { Button, Chip, Label, Panel, Switch, type Tone } from "./ui";

/**
 * The advisor roster (ADR-0039). `AdvisorRosterView` is bridge truth — what
 * this live session resolved — decorated with file-truth tools;
 * `AdvisorRosterEditor` edits file truth (omp's WATCHDOG.yml) and applies on
 * relaunch.
 */

type Load = { status: "loading" } | { status: "loaded"; result: WatchdogRosterResult } | { status: "error"; message: string };

function useRosterLoad(scopeCwd: string | null, instanceId: string | null): [Load, (r: WatchdogRosterResult) => void, () => void] {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    setLoad({ status: "loading" });
    backendFor(instanceId).getWatchdogRoster(scopeCwd).then(
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

const STATUS: Record<AdvisorMemberStatus, { label: string; tone: Tone }> = {
  running: { label: "running", tone: "neutral" },
  paused: { label: "paused", tone: "neutral" },
  no_model: { label: "no model", tone: "copper" },
  error: { label: "error", tone: "rose" },
  quota_exhausted: { label: "quota exhausted", tone: "copper" },
  unknown: { label: "unknown", tone: "neutral" },
};

export function AdvisorRosterView({
  tabId,
  instanceId,
  cwd,
  onEdit,
}: {
  tabId: string;
  instanceId: string | null;
  cwd: string | null;
  onEdit?: () => void;
}) {
  const stats = useStore((s) => s.rpc[tabId]?.advisorStats);
  const [load] = useRosterLoad(cwd, instanceId);
  const effective = load.status === "loaded" && load.result.status === "available" ? load.result.effective : [];
  if (stats?.available !== true) return null;
  const off = !stats.configured;
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="advisor-roster-view">
      <div className="flex items-center justify-between gap-2">
        <Label>Advisor roster</Label>
        {onEdit && (
          <Button size="xs" variant="ghost" onClick={onEdit}>
            Edit roster…
          </Button>
        )}
      </div>
      {off && (
        <Panel tone="copper" className="p-2">
          Advisor is off for this session — every entry is inactive.
        </Panel>
      )}
      {stats.configWarnings.length > 0 && (
        <Panel tone="copper" className="p-2">
          <ul className="list-disc pl-4">
            {stats.configWarnings.map((w, i) => (
              <li key={i} className="break-words">
                {w}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {stats.advisors.length === 0 && stats.configured && (
        <p className="text-ink-faint">omp reported no per-advisor data (older omp?) — showing session totals only.</p>
      )}
      {stats.advisors.length > 0 && (
        <table className="w-full text-left">
          <thead className="text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="font-medium">Advisor</th>
              <th className="font-medium">Model</th>
              <th className="text-right font-medium">Context</th>
              <th className="text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody>
            {stats.advisors.map((row, i) => {
              const file = effective.find((e) => e.slug === advisorSlug(row.name));
              const pct = row.contextWindow > 0 ? (row.contextTokens / row.contextWindow) * 100 : 0;
              const st = STATUS[row.status];
              const mutates = file?.tools.some((x) => WATCHDOG_MUTATING_TOOLS.includes(x)) ?? false;
              const model =
                row.model ?? (file !== undefined && file.model === null && row.status !== "running" ? "follows advisor model" : "—");
              return (
                <tr key={`${row.name}-${i}`} className="align-top border-t border-line-soft">
                  <td className="py-1 pr-2">
                    <div className="font-mono text-ink">{row.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <Chip tone={st.tone}>{st.label}</Chip>
                      {mutates && <Chip tone="rose">can change files</Chip>}
                    </div>
                    <div className="mt-0.5 break-words font-mono text-xs text-ink-faint">
                      {file ? file.tools.join(", ") || "—" : "—"}
                    </div>
                  </td>
                  <td className="py-1 pr-2 font-mono text-ink-mid break-all">{model}</td>
                  <td className="py-1 pr-2 text-right font-mono tabular-nums text-ink-mid">{pct.toFixed(1)}%</td>
                  <td className="py-1 text-right font-mono tabular-nums text-ink-mid">
                    <div>{stats.subscription && row.cost === 0 ? "sub" : formatCost(row.cost)}</div>
                    <div className="text-xs text-ink-faint">{compactNum(row.totalTokens)} tok</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="text-xs text-ink-faint">Rows describe this session's own advisors; descendant advisor spend is in the total above.</p>
    </div>
  );
}

const EMPTY_MODELS: ModelInfo[] = [];

function blankEntry(): WatchdogAdvisorEntry {
  return { name: "", model: null, tools: null, instructions: null, enabled: null, maxNotesPerUpdate: null };
}

function modelShapeOk(value: string): boolean {
  const role = parseModelRole(value);
  return role !== null && role.model.includes("/");
}

const inputClass =
  "w-full rounded border border-line bg-void px-2 py-1 font-mono text-xs text-ink outline-none focus:border-line-strong disabled:opacity-60";

export function AdvisorRosterEditor({ scopeCwd, instanceId }: { scopeCwd: string | null; instanceId: string | null }) {
  const [scope, setScope] = useState<WatchdogScope>(scopeCwd === null ? "user" : "project");
  const [load, setLoad, reload] = useRosterLoad(scopeCwd, instanceId);
  const [draft, setDraft] = useState<WatchdogDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickIndex, setPickIndex] = useState<number | null>(null);
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const restartSession = useStore((s) => s.restartSession);

  const view: WatchdogFileView | null =
    load.status === "loaded" && load.result.status === "available"
      ? scope === "project"
        ? load.result.project
        : load.result.user
      : null;

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

  if (load.status === "loading") return <p className="px-4 py-3 text-xs text-ink-faint">Loading advisor roster…</p>;
  if (load.status === "error" || load.result.status === "error") {
    const message = load.status === "error" ? load.message : (load.result as { message: string }).message;
    return (
      <div className="px-4 py-3 text-xs">
        <p className="text-rose">{message}</p>
        <Button size="xs" onClick={reload}>
          Reload
        </Button>
      </div>
    );
  }
  const result = load.result;
  if (result.status !== "available" || view === null || draft === null) return null;

  const blocked = view.blocking.length > 0;
  const update = (patch: Partial<WatchdogDocument>): void => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
    setSaved(false);
  };
  const updateEntry = (i: number, patch: Partial<WatchdogAdvisorEntry>): void =>
    update({ advisors: draft.advisors.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  const slugs = draft.advisors.map((a) => advisorSlug(a.name));
  const invalid =
    draft.advisors.some((a, i) => a.name.trim() === "" || slugs.indexOf(slugs[i]!) !== i || (a.model !== null && a.model !== "" && !modelShapeOk(a.model)));

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const doc: WatchdogDocument = {
        ...draft,
        advisors: draft.advisors.map((a) => ({ ...a, model: a.model?.trim() ? a.model.trim() : null })),
      };
      const next = await backendFor(instanceId).setWatchdogRoster({
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
    <div className="flex flex-col gap-3 px-4 py-3 text-xs" data-testid="advisor-roster-editor">
      <p className="text-xs leading-relaxed text-ink-faint">Entries without a model use the advisor model chosen in the composer (or omp's modelRoles.advisor); entries with a model use their own. The composer's advisor switch turns every entry off. Comments in WATCHDOG.yml are not preserved when saving.</p>
      <div className="flex items-center gap-2">
        <Button size="xs" selected={scope === "project"} disabled={scopeCwd === null} onClick={() => setScope("project")}>
          Project
        </Button>
        <Button size="xs" selected={scope === "user"} onClick={() => setScope("user")}>
          Global
        </Button>
        <span className="min-w-0 truncate font-mono text-xs text-ink-dim" title={view.path}>
          {view.path}
        </span>
      </div>
      {!view.exists && <p className="text-ink-faint">No WATCHDOG.yml at this scope.</p>}
      {view.blocking.length > 0 && (
        <Panel tone="rose" className="p-2">
          <p className="mb-1 font-medium">Saving is disabled — fix these by hand first:</p>
          <ul className="list-disc pl-4">
            {view.blocking.map((b, i) => (
              <li key={i} className="break-words">
                {b}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {view.notices.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-ink-faint">
          {view.notices.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <div>
        <Label>Shared instructions</Label>
        <textarea
          className={cn(inputClass, "mt-1 h-16")}
          aria-label="Shared instructions"
          disabled={blocked}
          value={draft.instructions ?? ""}
          onChange={(e) => update({ instructions: e.target.value === "" ? null : e.target.value })}
        />
        <label className="mt-1 flex items-center gap-2 text-xs text-ink-mid">
          Max notes per update
          <input
            type="number"
            min={1}
            className={cn(inputClass, "w-20")}
            disabled={blocked}
            value={draft.maxNotesPerUpdate ?? ""}
            onChange={(e) => update({ maxNotesPerUpdate: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </label>
      </div>

      {draft.advisors.map((a, i) => (
        <Panel key={i} className="flex flex-col gap-2 p-2.5">
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              placeholder="Advisor name"
              aria-label="Advisor"
              disabled={blocked}
              value={a.name}
              onChange={(e) => updateEntry(i, { name: e.target.value })}
            />
            <Switch
              on={a.enabled !== false}
              label="Enabled"
              disabled={blocked}
              onChange={(next) => updateEntry(i, { enabled: next ? null : false })}
            />
            <Button size="xs" variant="ghost" tone="rose" disabled={blocked} onClick={() => update({ advisors: draft.advisors.filter((_, j) => j !== i) })}>
              Remove
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              placeholder="provider/id (empty: follow advisor model)"
              aria-label="Model"
              disabled={blocked}
              value={a.model ?? ""}
              onChange={(e) => updateEntry(i, { model: e.target.value === "" ? null : e.target.value })}
            />
            {models.length > 0 && (
              <Button size="xs" disabled={blocked} onClick={() => setPickIndex(i)}>
                Pick…
              </Button>
            )}
          </div>
          {a.model !== null && a.model !== "" && !modelShapeOk(a.model) && (
            <p className="text-xs text-rose">use provider/model-id — omp's selectors name the provider</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="xs"
              selected={a.tools === null}
              disabled={blocked}
              title={WATCHDOG_DEFAULT_TOOLS.join(", ")}
              onClick={() => updateEntry(i, { tools: a.tools === null ? [...WATCHDOG_DEFAULT_TOOLS] : null })}
            >
              {`Default (${WATCHDOG_DEFAULT_TOOLS.join(", ")})`}
            </Button>
            {a.tools !== null &&
              WATCHDOG_KNOWN_TOOLS.map((tool) => (
                <Button
                  key={tool}
                  size="xs"
                  selected={a.tools!.includes(tool)}
                  disabled={blocked}
                  onClick={() =>
                    updateEntry(i, { tools: a.tools!.includes(tool) ? a.tools!.filter((x) => x !== tool) : [...a.tools!, tool] })
                  }
                >
                  {tool}
                </Button>
              ))}
          </div>
          <textarea
            className={cn(inputClass, "h-14")}
            aria-label="Instructions"
            placeholder="Instructions"
            disabled={blocked}
            value={a.instructions ?? ""}
            onChange={(e) => updateEntry(i, { instructions: e.target.value === "" ? null : e.target.value })}
          />
          <label className="flex items-center gap-2 text-xs text-ink-mid">
            Max notes per update
            <input
              type="number"
              min={1}
              className={cn(inputClass, "w-20")}
              disabled={blocked}
              value={a.maxNotesPerUpdate ?? ""}
              onChange={(e) => updateEntry(i, { maxNotesPerUpdate: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
        </Panel>
      ))}

      <div className="flex items-center gap-2">
        <Button size="xs" disabled={blocked} onClick={() => update({ advisors: [...draft.advisors, blankEntry()] })}>
          Add advisor
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
          Discard
        </Button>
        <Button size="xs" variant="solid" disabled={blocked || !dirty || invalid || saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {error !== null && (
        <div className="flex items-center gap-2 text-rose">
          <span className="break-words">{error}</span>
          <Button size="xs" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      {saved && (
        <Panel className="p-2">
          <p>Saved. Running sessions keep their roster until restarted.</p>
          {liveSessions.map((s) => (
            <div key={s.tabId} className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate">{s.title}</span>
              <Button size="xs" onClick={() => void restartSession(s.tabId)}>
                Restart
              </Button>
            </div>
          ))}
        </Panel>
      )}

      {result.otherFiles.length > 0 && (
        <div className="text-xs text-ink-faint">
          <p>Also contributing (edit by hand):</p>
          <ul className="font-mono text-xs">
            {result.otherFiles.map((f) => (
              <li key={f} className="break-all">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <ul className="list-disc pl-4 text-xs text-copper">
          {result.warnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Label>Effective roster</Label>
        {result.effective.length === 0 ? (
          <p className="text-ink-faint">No advisors configured — omp uses its single default advisor.</p>
        ) : (
          <ul className="mt-1 font-mono text-xs text-ink-mid">
            {result.effective.map((e) => (
              <li key={e.slug} className="break-all">
                {e.name} · {e.enabled ? "on" : "off"} · {e.model ?? "follows advisor model"} · {e.tools.join(",") || "—"} · {e.sourcePath}
              </li>
            ))}
          </ul>
        )}
      </div>

      {pickIndex !== null && (
        <ModelPalette
          variant="subagent"
          models={models}
          current={draft.advisors[pickIndex]?.model ?? null}
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
