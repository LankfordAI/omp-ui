import { useCallback, useMemo, useState } from "react";
import {
  FLEET_BATCH_MAX,
  FLEET_PROMPT_MAX,
  FLEET_TITLE_MAX,
  LOCAL_MACHINE_KEY,
  type FleetDispatchOutcome,
  type FleetDispatchRequest,
  type FleetHostProject,
  type FleetMachine,
  type FleetTargetPick,
} from "@omp-ui/core/fleet";
import { backend } from "../../backend";
import { useT } from "../../lib/i18n";
import { useLoad } from "../../lib/load";
import { useStore } from "../../store";
import { Button, ChoiceCapsule, ConfirmDialog, IconButton, IconPlus } from "../ui";

/**
 * Fleet dispatch (issue #899, ADR-0061): one prompt started as fresh native
 * sessions on one or more fleet machines. The dialog reads the machines once
 * on open and builds a FleetDispatchRequest; main's FleetDispatcher places,
 * validates, and spawns. Outcomes other than "started" keep the dialog open
 * and list per target — an unknown outcome also lands in the Fleet view's
 * Unresolved section.
 */

const FIELD =
  "mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong";
const LABEL = "block text-[10px] text-ink-faint";
const HINT = "mt-1.5 text-[10px] leading-snug text-ink-faint";

/** One registered project on one ready machine: a possible reference target. */
interface ProjectOption {
  /** `machineKey` NUL `path` — unique across the fleet, never shown. */
  id: string;
  machine: FleetMachine;
  project: FleetHostProject;
}

export function FleetDispatchDialog() {
  const t = useT();
  const closeFleetDispatch = useStore((s) => s.closeFleetDispatch);
  const dispatchFleet = useStore((s) => s.dispatchFleet);
  const openFleet = useStore((s) => s.openFleet);
  const focused = useStore((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null);
  const readMachines = useCallback(() => backend.fleetMachines(), []);
  const { load } = useLoad(readMachines);
  const machines = load.status === "loaded" ? load.value : null;

  const options = useMemo(() => {
    const out: ProjectOption[] = [];
    for (const machine of machines ?? []) {
      if (machine.status !== "ready" || machine.report === null) continue;
      for (const project of machine.report.projects) {
        out.push({ id: `${machine.key}\u0000${project.path}`, machine, project });
      }
    }
    return out;
  }, [machines]);
  /** Options grouped by repository key, in first-seen order; null = no web remote. */
  const grouped = useMemo(() => {
    const groups = new Map<string | null, ProjectOption[]>();
    for (const option of options) {
      const list = groups.get(option.project.repositoryKey);
      if (list === undefined) groups.set(option.project.repositoryKey, [option]);
      else list.push(option);
    }
    return [...groups];
  }, [options]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const focusedId = focused === null ? null : `${focused.instanceId ?? LOCAL_MACHINE_KEY}\u0000${focused.projectCwd}`;
  const reference =
    options.find((o) => o.id === pickedId) ?? options.find((o) => o.id === focusedId) ?? options[0] ?? null;

  /** Machines that can run the reference's repository: first matching project per machine. */
  const candidates = useMemo(() => {
    if (reference === null) return [];
    const key = reference.project.repositoryKey;
    if (key === null) return [reference];
    const out: ProjectOption[] = [];
    for (const option of options) {
      if (option.project.repositoryKey !== key) continue;
      if (out.some((o) => o.machine.key === option.machine.key)) continue;
      // The reference machine always runs the reference project itself.
      out.push(option.machine.key === reference.machine.key ? reference : option);
    }
    return out;
  }, [options, reference]);

  const [runOn, setRunOn] = useState<"auto" | "choose">("auto");
  const [autoCopies, setAutoCopies] = useState(1);
  /** Choose mode: copies per machine key; absent or 0 = not chosen. Keyed to the reference. */
  const [copies, setCopies] = useState<{ referenceId: string | null; byMachine: Record<string, number> }>({
    referenceId: null,
    byMachine: {},
  });
  const byMachine =
    reference !== null && copies.referenceId === reference.id
      ? copies.byMachine
      : reference === null
        ? {}
        : { [reference.machine.key]: 1 };
  const chosen = candidates.filter((c) => (byMachine[c.machine.key] ?? 0) > 0);
  const chosenTotal = chosen.reduce((sum, c) => sum + byMachine[c.machine.key]!, 0);
  const setMachineCopies = (machineKey: string, count: number): void => {
    if (reference === null) return;
    setCopies({ referenceId: reference.id, byMachine: { ...byMachine, [machineKey]: count } });
  };

  const [workspace, setWorkspace] = useState<FleetDispatchRequest["workspace"]>("worktree");
  const [planMode, setPlanMode] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsettled, setUnsettled] = useState<FleetDispatchOutcome[]>([]);

  const checkoutDisabled =
    runOn === "auto" ? autoCopies > 1 : chosen.some((c) => byMachine[c.machine.key]! > 1);
  const effectiveWorkspace = checkoutDisabled ? "worktree" : workspace;
  const targets = runOn === "auto" ? candidates : chosen;
  const commitsDiffer =
    new Set(targets.map((c) => c.project.headCommit).filter((commit) => commit !== null)).size > 1;
  const nameOf = (machine: Pick<FleetMachine, "nickname">): string =>
    machine.nickname ?? t("fleet.machine.thisComputer");

  const canSubmit =
    !busy && reference !== null && prompt.trim() !== "" && (runOn === "auto" || chosenTotal > 0);

  const close = (): void => {
    if (!busy) closeFleetDispatch();
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit || reference === null) return;
    const picks: FleetTargetPick[] = [];
    if (runOn === "choose") {
      for (const c of chosen) {
        for (let i = 0; i < byMachine[c.machine.key]!; i++) {
          picks.push({ machineKey: c.machine.key, projectCwd: c.project.path });
        }
      }
    }
    const req: FleetDispatchRequest = {
      targets:
        runOn === "auto"
          ? {
              kind: "auto",
              reference: { machineKey: reference.machine.key, projectCwd: reference.project.path },
              count: autoCopies,
            }
          : { kind: "explicit", picks },
      prompt,
      title: title.trim() === "" ? null : title.trim(),
      workspace: effectiveWorkspace,
      planMode,
    };
    setBusy(true);
    const result = await dispatchFleet(req);
    setBusy(false);
    if (result === null) return;
    const notStarted = result.outcomes.filter((o) => o.status !== "started");
    if (notStarted.length === 0) {
      closeFleetDispatch();
      openFleet();
      return;
    }
    setUnsettled(notStarted);
  };

  return (
    <ConfirmDialog
      kicker={t("fleet.dialog.kicker")}
      title={t("fleet.dialog.title")}
      tone="signal"
      onClose={close}
      width="w-[32rem]"
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.dialog.cancel")}
          </Button>
          <Button variant="solid" tone="signal" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t("fleet.dialog.busy") : t("fleet.dialog.action")}
          </Button>
        </>
      }
    >
      {load.status === "error" ? (
        <p className="text-xs leading-relaxed text-rose">{load.message}</p>
      ) : machines === null ? (
        <p className="text-xs text-ink-faint">{t("fleet.dialog.loading")}</p>
      ) : reference === null ? (
        <p className="text-xs text-ink-faint">{t("fleet.dialog.noProjects")}</p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="fleet-project" className={LABEL}>
              {t("fleet.dialog.project")}
            </label>
            <select
              id="fleet-project"
              value={reference.id}
              disabled={busy}
              onChange={(event) => setPickedId(event.target.value)}
              className={FIELD}
            >
              {grouped.map(([key, list]) => (
                <optgroup key={key ?? ""} label={key ?? t("fleet.dialog.noRepositoryKey")}>
                  {list.map((option) => (
                    <option key={option.id} value={option.id}>
                      {nameOf(option.machine)} · {option.project.name} — {option.project.path}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div>
            <p className={LABEL}>{t("fleet.dialog.runOn")}</p>
            <div className="mt-1.5 flex items-center gap-3">
              <ChoiceCapsule
                label={t("fleet.dialog.runOn")}
                value={runOn}
                options={[
                  { value: "auto", label: t("fleet.dialog.auto") },
                  { value: "choose", label: t("fleet.dialog.choose") },
                ]}
                onChange={setRunOn}
              />
              {runOn === "auto" && (
                <label className="flex items-center gap-1.5 text-[11px] text-ink-mid">
                  {t("fleet.dialog.copies")}
                  <select
                    aria-label={t("fleet.dialog.copies")}
                    value={autoCopies}
                    disabled={busy}
                    onChange={(event) => setAutoCopies(Number(event.target.value))}
                    className="h-6 rounded-md border border-line bg-raised px-1.5 text-[11px] text-ink-mid"
                  >
                    {Array.from({ length: FLEET_BATCH_MAX }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {runOn === "choose" && reference.project.repositoryKey === null && (
              <p className={HINT}>{t("fleet.dialog.onlyReference")}</p>
            )}
            {runOn === "choose" && (
              <ul className="mt-2 space-y-1">
                {candidates.map((c) => {
                  const count = byMachine[c.machine.key] ?? 0;
                  const name = nameOf(c.machine);
                  return (
                    <li
                      key={c.machine.key}
                      className="flex items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-1.5 text-xs text-ink-mid"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={count > 0}
                          disabled={busy || (count === 0 && chosenTotal >= FLEET_BATCH_MAX)}
                          onChange={(event) => setMachineCopies(c.machine.key, event.target.checked ? 1 : 0)}
                          className="size-3.5 accent-current"
                        />
                        <span className="truncate">{name}</span>
                        <span className="min-w-0 truncate font-mono text-[10px] text-ink-faint">{c.project.path}</span>
                      </label>
                      {count > 0 && (
                        <span className="flex shrink-0 items-center gap-1" aria-label={t("fleet.dialog.copiesFor", { machine: name })}>
                          <IconButton
                            label={t("fleet.dialog.fewer", { machine: name })}
                            disabled={busy || count <= 1}
                            onClick={() => setMachineCopies(c.machine.key, count - 1)}
                          >
                            <span aria-hidden className="text-xs">−</span>
                          </IconButton>
                          <span className="w-4 text-center font-mono text-[11px] tabular-nums text-ink">{count}</span>
                          <IconButton
                            label={t("fleet.dialog.more", { machine: name })}
                            disabled={busy || chosenTotal >= FLEET_BATCH_MAX}
                            onClick={() => setMachineCopies(c.machine.key, count + 1)}
                          >
                            <IconPlus />
                          </IconButton>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap gap-6">
            <div>
              <p className={LABEL}>{t("fleet.dialog.workspace")}</p>
              <div className="mt-1.5">
                <ChoiceCapsule
                  label={t("fleet.dialog.workspace")}
                  value={effectiveWorkspace}
                  options={[
                    { value: "worktree", label: t("fleet.dialog.worktree") },
                    {
                      value: "checkout",
                      label: t("fleet.dialog.checkout"),
                      disabled: checkoutDisabled,
                      title: checkoutDisabled ? t("fleet.dialog.checkoutDisabled") : undefined,
                    },
                  ]}
                  onChange={setWorkspace}
                />
              </div>
            </div>
            <div>
              <p className={LABEL}>{t("fleet.dialog.mode")}</p>
              <div className="mt-1.5">
                <ChoiceCapsule
                  label={t("fleet.dialog.mode")}
                  value={planMode ? "plan" : "build"}
                  options={[
                    { value: "build", label: t("fleet.dialog.build") },
                    { value: "plan", label: t("fleet.dialog.plan") },
                  ]}
                  onChange={(mode) => setPlanMode(mode === "plan")}
                />
              </div>
            </div>
          </div>

          {commitsDiffer && <p className="text-[11px] leading-relaxed text-copper">{t("fleet.dialog.commitsDiffer")}</p>}

          <div>
            <label htmlFor="fleet-title" className={LABEL}>
              {t("fleet.dialog.titleField")}
            </label>
            <input
              id="fleet-title"
              value={title}
              maxLength={FLEET_TITLE_MAX}
              disabled={busy}
              placeholder={t("fleet.dialog.titlePlaceholder")}
              spellCheck={false}
              onChange={(event) => setTitle(event.target.value)}
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="fleet-prompt" className={LABEL}>
              {t("fleet.dialog.prompt")}
            </label>
            <textarea
              id="fleet-prompt"
              rows={5}
              value={prompt}
              maxLength={FLEET_PROMPT_MAX}
              disabled={busy}
              spellCheck={false}
              onChange={(event) => setPrompt(event.target.value)}
              className={`${FIELD} resize-none`}
              data-modal-initial-focus
            />
          </div>

          {unsettled.length > 0 && (
            <ul className="space-y-1 text-[11px] leading-relaxed">
              {unsettled.map((o) => {
                const machine = machines.find((m) => m.key === o.machineKey);
                return (
                  <li key={o.dispatchId} className={o.status === "failed" ? "text-rose" : "text-copper"}>
                    {o.status !== "started" &&
                      t(o.status === "failed" ? "fleet.dialog.failed" : "fleet.dialog.unknown", {
                        machine: machine === undefined ? o.machineKey : nameOf(machine),
                        message: o.message,
                      })}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
