import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { mintBranchName, worktreeBranchPrefix } from "@omp-ui/core/worktree-branch";
import { backend } from "../backend";
import { useT } from "../lib/i18n";
import { useLoad } from "../lib/load";
import { projectKey } from "../lib/project-key";
import { useStore } from "../store";
import { Button, ChoiceCapsule, ConfirmDialog, IconButton, IconPlus } from "./ui";
import { WorktreeBranchFields } from "./WorktreeBranchFields";

/**
 * The one New session dialog (issue #900), replacing the separate worktree
 * dialog and fleet dispatch dialog. The Where capsule picks the face: "here"
 * launches through launchSession — optionally in a fresh worktree, with an
 * optional title and first prompt riding the spawn render-side as a seed —
 * while "fleet" ports FleetDispatchDialog's fields verbatim and builds a
 * FleetDispatchRequest for main's FleetDispatcher (ADR-0061 provenance stays
 * on dispatches; the local seed is not staged through it). An empty prompt is
 * legal locally (an idle session) and illegal on the fleet.
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

/** One registry project on the "here" face: this app's own or a joined instance's. */
interface HereOption {
  /** `machineKey` NUL `path` — same encoding as the fleet face, never shown. */
  id: string;
  /** The owning instance; null = this host. */
  instanceId: string | null;
  projectCwd: string;
  label: string;
  /** Full path shown as the option's tooltip. */
  title?: string;
}

export function NewSessionDialog() {
  const t = useT();
  const seed = useStore((s) => s.newSessionDialog);
  const closeNewSessionDialog = useStore((s) => s.closeNewSessionDialog);
  const launchSession = useStore((s) => s.launchSession);
  const dispatchFleet = useStore((s) => s.dispatchFleet);
  const openFleet = useStore((s) => s.openFleet);
  const focused = useStore((s) => s.tabs.find((tab) => tab.tabId === s.activeTabId) ?? null);
  const state = useStore((s) => s.state);
  const branches = useStore((s) => s.branches);
  const refreshBranches = useStore((s) => s.refreshBranches);

  // The Where capsule needs at least one other instance to offer the fleet
  // face: without a joined machine the dialog is local-only.
  const joined = useMemo(
    () => (state?.remoteInstances ?? []).filter((instance) => instance.status !== "self"),
    [state],
  );
  const [where, setWhere] = useState<"here" | "fleet">(() => seed?.where ?? "here");
  const face: "here" | "fleet" = joined.length > 0 ? where : "here";

  // Machines are a fleet-face concern only: the read stays lazy so the local
  // face never touches them (the LOCAL read is correct — machines come from
  // this app).
  const readMachines = useCallback(() => backend.fleetMachines(), []);
  const { load } = useLoad(face === "fleet" ? readMachines : null);
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

  const hereOptions = useMemo(() => {
    const out: HereOption[] = [];
    for (const group of state?.projects ?? []) {
      out.push({
        id: `${LOCAL_MACHINE_KEY}\u0000${group.project.path}`,
        instanceId: null,
        projectCwd: group.project.path,
        label: group.project.name,
      });
    }
    for (const instance of joined) {
      for (const group of instance.projects) {
        out.push({
          id: `${instance.id}\u0000${group.project.path}`,
          instanceId: instance.id,
          projectCwd: group.project.path,
          label: `${instance.nickname} · ${group.project.name}`,
          title: group.project.path,
        });
      }
    }
    return out;
  }, [state, joined]);

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

  const [workspace, setWorkspace] = useState<"checkout" | "worktree">(() => seed?.workspace ?? "worktree");
  const [planMode, setPlanMode] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [unsettled, setUnsettled] = useState<FleetDispatchOutcome[]>([]);

  // The fleet checkout rule: several copies on one machine share one checkout,
  // so each needs its own worktree.
  const checkoutDisabled =
    runOn === "auto" ? autoCopies > 1 : chosen.some((c) => byMachine[c.machine.key]! > 1);

  // ---- The here face's selection ------------------------------------------

  const seedId =
    seed !== null && seed.projectCwd !== null
      ? `${seed.instanceId ?? LOCAL_MACHINE_KEY}\u0000${seed.projectCwd}`
      : null;
  const selection =
    hereOptions.find((o) => o.id === pickedId) ??
    (seedId === null ? undefined : hereOptions.find((o) => o.id === seedId)) ??
    (focusedId === null ? undefined : hereOptions.find((o) => o.id === focusedId)) ??
    hereOptions[0] ??
    null;
  const instanceId = selection?.instanceId ?? null;
  const projectCwd = selection?.projectCwd ?? "";

  // null repoRoot (not undefined — undefined means the listing hasn't loaded
  // yet) means the project isn't a git repository at all: no worktree there.
  const info = selection === null ? undefined : branches[projectKey(instanceId, projectCwd)];
  const notGit = info?.repoRoot === null;
  // The checkout's own branch cannot be worked in twice: git would refuse
  // the second checkout, so the candidate list drops it.
  const otherBranches = (info?.branches ?? []).filter((name) => name !== info?.current);

  // The local worktree fields, mirroring NewWorktreeSessionDialog: null baseRef
  // cuts from the checkout's HEAD; baseBranch (issue #405) null = cut from
  // baseRef, ""/name = create that base branch from baseRef first.
  const [source, setSource] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState(() => mintBranchName(worktreeBranchPrefix(projectCwd)));
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [existingBranch, setExistingBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A minted branch names its project: when the picked project changes, re-mint.
  const mintedForRef = useRef(selection?.id ?? "");
  useEffect(() => {
    const id = selection?.id ?? "";
    if (id === mintedForRef.current) return;
    mintedForRef.current = id;
    setBranch(mintBranchName(worktreeBranchPrefix(selection?.projectCwd ?? "")));
    setExistingBranch("");
  }, [selection]);

  useEffect(() => {
    if (existingBranch === "" && otherBranches.length > 0) setExistingBranch(otherBranches[0]);
  }, [otherBranches, existingBranch]);

  // The existing list is opened rarely; refresh it when the segment is
  // picked so a branch created outside omp-ui shows up (local refs only).
  const worktreeHere = face === "here" && !notGit && workspace === "worktree";
  useEffect(() => {
    if (worktreeHere && source === "existing" && selection !== null) {
      void refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    }
  }, [worktreeHere, source, selection, projectCwd, instanceId, refreshBranches]);

  const effectiveWorkspace = face === "fleet" ? (checkoutDisabled ? "worktree" : workspace) : notGit ? "checkout" : workspace;
  const targets = runOn === "auto" ? candidates : chosen;
  const commitsDiffer =
    new Set(targets.map((c) => c.project.headCommit).filter((commit) => commit !== null)).size > 1;
  const nameOf = (machine: Pick<FleetMachine, "nickname">): string =>
    machine.nickname ?? t("dialog.newsession.here");

  const canSubmit =
    face === "fleet"
      ? !busy && reference !== null && prompt.trim() !== "" && (runOn === "auto" || chosenTotal > 0)
      : !busy &&
        selection !== null &&
        (effectiveWorkspace === "checkout" ||
          (info !== undefined &&
            info.repoRoot !== null &&
            !(source === "existing" && otherBranches.length === 0) &&
            !(source === "new" && baseBranch !== null && baseBranch.trim() === "")));

  const close = (): void => {
    if (!busy) closeNewSessionDialog();
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    if (face === "fleet") {
      if (reference === null) return;
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
        closeNewSessionDialog();
        openFleet();
        return;
      }
      setUnsettled(notStarted);
      return;
    }
    if (selection === null) return;
    const worktree =
      effectiveWorkspace === "worktree"
        ? source === "new"
          ? { mint: { branch, baseRef, baseBranch } }
          : { checkout: { branch: existingBranch } }
        : null;
    setBusy(true);
    try {
      // A null return means the spawn already reported its failure — close
      // anyway; a thrown worktree spawn (git's stderr) stays inline here.
      await launchSession(projectCwd, { instanceId, prompt, title, planMode, worktree });
      closeNewSessionDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      kicker={t("dialog.newsession.kicker")}
      title={t("dialog.newsession.title")}
      tone="signal"
      onClose={close}
      width="w-[32rem]"
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t("common.dialog.cancel")}
          </Button>
          <Button variant="solid" tone="signal" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t("dialog.newsession.busy") : t("dialog.newsession.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {joined.length > 0 && (
          <div>
            <p className={LABEL}>{t("dialog.newsession.where")}</p>
            <div className="mt-1.5">
              <ChoiceCapsule
                label={t("dialog.newsession.where")}
                value={face}
                options={[
                  { value: "here", label: t("dialog.newsession.here") },
                  { value: "fleet", label: t("dialog.newsession.fleet") },
                ]}
                onChange={setWhere}
              />
            </div>
          </div>
        )}

        {face === "here" ? (
          selection === null ? (
            <p className="text-xs text-ink-faint">{t("dialog.newsession.noProjects")}</p>
          ) : (
            <>
              <div>
                <label htmlFor="newsession-project" className={LABEL}>
                  {t("dialog.newsession.project")}
                </label>
                <select
                  id="newsession-project"
                  value={selection.id}
                  disabled={busy}
                  onChange={(event) => setPickedId(event.target.value)}
                  className={FIELD}
                >
                  {hereOptions.map((option) => (
                    <option key={option.id} value={option.id} title={option.title}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap gap-6">
                <div>
                  <p className={LABEL}>{t("dialog.newsession.workspace")}</p>
                  <div className="mt-1.5">
                    <ChoiceCapsule
                      label={t("dialog.newsession.workspace")}
                      value={effectiveWorkspace}
                      options={[
                        { value: "checkout", label: t("dialog.newsession.checkout") },
                        {
                          value: "worktree",
                          label: t("dialog.newsession.worktree"),
                          disabled: notGit,
                          title: notGit ? t("dialog.worktree.notGit") : undefined,
                        },
                      ]}
                      onChange={setWorkspace}
                    />
                  </div>
                </div>
                <div>
                  <p className={LABEL}>{t("dialog.newsession.mode")}</p>
                  <div className="mt-1.5">
                    <ChoiceCapsule
                      label={t("dialog.newsession.mode")}
                      value={planMode ? "plan" : "build"}
                      options={[
                        { value: "build", label: t("dialog.newsession.build") },
                        { value: "plan", label: t("dialog.newsession.plan") },
                      ]}
                      onChange={(mode) => setPlanMode(mode === "plan")}
                    />
                  </div>
                </div>
              </div>

              {worktreeHere && (
                <>
                  <ChoiceCapsule
                    label={t("dialog.worktree.sourceLabel")}
                    value={source}
                    onChange={setSource}
                    options={[
                      { value: "new", label: t("dialog.worktree.sourceNew") },
                      {
                        value: "existing",
                        label: t("dialog.worktree.sourceExisting"),
                        disabled: otherBranches.length === 0,
                        title: otherBranches.length === 0 ? t("dialog.worktree.noOtherBranches") : undefined,
                      },
                    ]}
                  />
                  {source === "new" ? (
                    <WorktreeBranchFields
                      projectCwd={projectCwd}
                      instanceId={instanceId}
                      branch={branch}
                      onBranchChange={setBranch}
                      baseRef={baseRef}
                      onBaseRefChange={setBaseRef}
                      baseBranch={baseBranch}
                      onBaseBranchChange={setBaseBranch}
                      idPrefix="newsession"
                    />
                  ) : (
                    <div>
                      <label htmlFor="newsession-existing" className="block text-[10px] text-ink-faint">
                        {t("dialog.worktree.existingBranch")}
                      </label>
                      <select
                        id="newsession-existing"
                        value={existingBranch}
                        onChange={(event) => setExistingBranch(event.target.value)}
                        className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-line-strong"
                      >
                        {otherBranches.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
                        {t("dialog.worktree.existingHint")}
                      </p>
                    </div>
                  )}
                </>
              )}

              <div>
                <label htmlFor="newsession-title" className={LABEL}>
                  {t("dialog.newsession.titleField")}
                </label>
                <input
                  id="newsession-title"
                  value={title}
                  maxLength={FLEET_TITLE_MAX}
                  disabled={busy}
                  placeholder={t("dialog.newsession.titlePlaceholder")}
                  spellCheck={false}
                  onChange={(event) => setTitle(event.target.value)}
                  className={FIELD}
                />
              </div>

              <div>
                <label htmlFor="newsession-prompt" className={LABEL}>
                  {t("dialog.newsession.prompt")}
                </label>
                <textarea
                  id="newsession-prompt"
                  rows={5}
                  value={prompt}
                  maxLength={FLEET_PROMPT_MAX}
                  disabled={busy}
                  spellCheck={false}
                  onChange={(event) => setPrompt(event.target.value)}
                  className={`${FIELD} resize-none`}
                  data-modal-initial-focus
                />
                <p className={HINT}>{t("dialog.newsession.promptHintHere")}</p>
              </div>

              {error !== null && <p className="text-xs leading-relaxed text-rose">{error}</p>}
            </>
          )
        ) : load.status === "error" ? (
          <p className="text-xs leading-relaxed text-rose">{load.message}</p>
        ) : machines === null ? (
          <p className="text-xs text-ink-faint">{t("dialog.newsession.loading")}</p>
        ) : reference === null ? (
          <p className="text-xs text-ink-faint">{t("dialog.newsession.noFleetProjects")}</p>
        ) : (
          <>
            <div>
              <label htmlFor="newsession-project" className={LABEL}>
                {t("dialog.newsession.project")}
              </label>
              <select
                id="newsession-project"
                value={reference.id}
                disabled={busy}
                onChange={(event) => setPickedId(event.target.value)}
                className={FIELD}
              >
                {grouped.map(([key, list]) => (
                  <optgroup key={key ?? ""} label={key ?? t("dialog.newsession.noRepositoryKey")}>
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
              <p className={LABEL}>{t("dialog.newsession.runOn")}</p>
              <div className="mt-1.5 flex items-center gap-3">
                <ChoiceCapsule
                  label={t("dialog.newsession.runOn")}
                  value={runOn}
                  options={[
                    { value: "auto", label: t("dialog.newsession.auto") },
                    { value: "choose", label: t("dialog.newsession.choose") },
                  ]}
                  onChange={setRunOn}
                />
                {runOn === "auto" && (
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-mid">
                    {t("dialog.newsession.copies")}
                    <select
                      aria-label={t("dialog.newsession.copies")}
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
                <p className={HINT}>{t("dialog.newsession.onlyReference")}</p>
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
                          <span className="flex shrink-0 items-center gap-1" aria-label={t("dialog.newsession.copiesFor", { machine: name })}>
                            <IconButton
                              label={t("dialog.newsession.fewer", { machine: name })}
                              disabled={busy || count <= 1}
                              onClick={() => setMachineCopies(c.machine.key, count - 1)}
                            >
                              <span aria-hidden className="text-xs">−</span>
                            </IconButton>
                            <span className="w-4 text-center font-mono text-[11px] tabular-nums text-ink">{count}</span>
                            <IconButton
                              label={t("dialog.newsession.more", { machine: name })}
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
                <p className={LABEL}>{t("dialog.newsession.workspace")}</p>
                <div className="mt-1.5">
                  <ChoiceCapsule
                    label={t("dialog.newsession.workspace")}
                    value={effectiveWorkspace}
                    options={[
                      { value: "worktree", label: t("dialog.newsession.worktree") },
                      {
                        value: "checkout",
                        label: t("dialog.newsession.checkout"),
                        disabled: checkoutDisabled,
                        title: checkoutDisabled ? t("dialog.newsession.checkoutDisabled") : undefined,
                      },
                    ]}
                    onChange={setWorkspace}
                  />
                </div>
              </div>
              <div>
                <p className={LABEL}>{t("dialog.newsession.mode")}</p>
                <div className="mt-1.5">
                  <ChoiceCapsule
                    label={t("dialog.newsession.mode")}
                    value={planMode ? "plan" : "build"}
                    options={[
                      { value: "build", label: t("dialog.newsession.build") },
                      { value: "plan", label: t("dialog.newsession.plan") },
                    ]}
                    onChange={(mode) => setPlanMode(mode === "plan")}
                  />
                </div>
              </div>
            </div>

            {commitsDiffer && <p className="text-[11px] leading-relaxed text-copper">{t("dialog.newsession.commitsDiffer")}</p>}

            <div>
              <label htmlFor="newsession-title" className={LABEL}>
                {t("dialog.newsession.titleField")}
              </label>
              <input
                id="newsession-title"
                value={title}
                maxLength={FLEET_TITLE_MAX}
                disabled={busy}
                placeholder={t("dialog.newsession.titlePlaceholder")}
                spellCheck={false}
                onChange={(event) => setTitle(event.target.value)}
                className={FIELD}
              />
            </div>

            <div>
              <label htmlFor="newsession-prompt" className={LABEL}>
                {t("dialog.newsession.prompt")}
              </label>
              <textarea
                id="newsession-prompt"
                rows={5}
                value={prompt}
                maxLength={FLEET_PROMPT_MAX}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setPrompt(event.target.value)}
                className={`${FIELD} resize-none`}
                data-modal-initial-focus
              />
              <p className={HINT}>{t("dialog.newsession.promptHintFleet")}</p>
            </div>

            {unsettled.length > 0 && (
              <ul className="space-y-1 text-[11px] leading-relaxed">
                {unsettled.map((o) => {
                  const machine = machines.find((m) => m.key === o.machineKey);
                  return (
                    <li key={o.dispatchId} className={o.status === "failed" ? "text-rose" : "text-copper"}>
                      {o.status !== "started" &&
                        t(o.status === "failed" ? "dialog.newsession.failed" : "dialog.newsession.unknown", {
                          machine: machine === undefined ? o.machineKey : nameOf(machine),
                          message: o.message,
                        })}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
