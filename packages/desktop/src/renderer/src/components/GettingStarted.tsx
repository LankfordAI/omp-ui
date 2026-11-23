import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MIN_SUPPORTED_OMP } from "@omp-ui/core/harness-floor";
import { compareVersions } from "@omp-ui/core/semver";
import type { PythonCheckSnapshot } from "@omp-ui/core/types";
import { backend, displayMessage } from "../backend";
import { useStore } from "../store";
import { Button, Modal } from "./ui";
import { CheckIcon } from "./ui/icons";

/**
 * The first-run Getting started checklist (issue #623): four gates a fresh
 * install must pass — the managed omp binary, a provider credential, a
 * registered project, a first owned session — each read live from backend
 * state the app already fetches, with one working action per unmet step,
 * plus one environment probe: omp's own `setup python --check` verdict on
 * whether its eval tool can run Python (#671).
 * Per-renderer visibility only: the sole persisted fact is `gettingStartedSeen`,
 * written once on dismissal.
 */

/** One checklist row: status glyph, title, quiet hint, and — while not done —
 *  a single action button. */
function Step({
  done,
  title,
  hint,
  action,
}: {
  done: boolean;
  title: string;
  hint: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 px-5 py-3.5">
      <span className="mt-0.5 flex w-5 shrink-0 justify-center" aria-hidden>
        {done ? (
          <span className="flex size-5 items-center justify-center rounded-full border border-line-strong bg-raised text-ink">
            <CheckIcon />
          </span>
        ) : (
          <span className="mt-1 size-3 rounded-full border border-line-strong" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className={done ? "text-sm font-medium text-ink-dim" : "text-sm font-medium text-ink"}>
          {title}
        </p>
        <p className="mt-0.5 text-xs text-ink-dim">{hint}</p>
      </div>
      {done ? null : <div className="shrink-0 pt-0.5">{action}</div>}
    </li>
  );
}

export function GettingStarted() {
  const titleId = useId();
  const dismiss = useStore((s) => s.dismissGettingStarted);
  const openSettings = useStore((s) => s.openSettings);
  const openProjectPicker = useStore((s) => s.openProjectPicker);
  const newSession = useStore((s) => s.newSession);
  const ompUpdate = useStore((s) => s.ompUpdate);
  const downloadOmpUpdate = useStore((s) => s.downloadOmpUpdate);
  const checkOmpUpdate = useStore((s) => s.checkOmpUpdate);
  const settingsPage = useStore((s) => s.settingsPage);
  const providerOAuth = useStore((s) => s.providerOAuth);
  const readProviderKeys = useStore((s) => s.readProviderKeys);
  const readProviderOAuth = useStore((s) => s.readProviderOAuth);
  const reportError = useStore((s) => s.reportError);
  const projects = useStore((s) => s.state?.projects);

  // Step 2 is the only gate that is a read rather than a derivation, so it
  // re-reads with ProvidersPage's generation discipline: a stale answer must
  // never overwrite a fresher one. A failed read leaves the step open but
  // actionable — never a false "done".
  const [providerDone, setProviderDone] = useState(false);
  const gen = useRef(0);
  const reread = useCallback((): void => {
    const g = ++gen.current;
    void Promise.all([readProviderKeys(null), readProviderOAuth()]).then(
      ([keys, subscriptions]) => {
        if (g !== gen.current) return;
        setProviderDone(
          keys.providers.some((row) => row.group === "models" && row.source !== "none") ||
            subscriptions.some((row) => row.credentials.length > 0) ||
            keys.configFileProviders.length > 0,
        );
      },
      (err: unknown) => {
        if (g !== gen.current) return;
        setProviderDone(false);
        reportError(err instanceof Error ? err : new Error(displayMessage(err)));
      },
    );
  }, [readProviderKeys, readProviderOAuth, reportError]);

  useEffect(reread, [reread]);

  // The Python probe (#671) rides its own channel with the same generation
  // discipline as the credentials read: a stale answer must never overwrite
  // a fresher one, and a failed read leaves the step open but actionable —
  // never a false "done".
  const [python, setPython] = useState<PythonCheckSnapshot | null>(null);
  const pythonGen = useRef(0);
  const rereadPython = useCallback((): void => {
    const g = (pythonGen.current += 1);
    backend.checkPython().then(
      (snap) => {
        if (g === pythonGen.current) setPython(snap);
      },
      (err) => {
        if (g !== pythonGen.current) return;
        setPython({
          status: "error",
          pythonPath: null,
          version: null,
          error: displayMessage(err),
        });
      },
    );
  }, []);

  useEffect(rereadPython, [rereadPython]);

  // The step's own action opened Settings; when the user closes it, the keys
  // and the Python rows they typed there are the news these reads pick up.
  const previousSettingsPage = useRef(settingsPage);
  useEffect(() => {
    if (previousSettingsPage.current !== null && settingsPage === null) {
      reread();
      rereadPython();
    }
    previousSettingsPage.current = settingsPage;
  }, [settingsPage, reread, rereadPython]);

  // A finished subscription sign-in adds accounts (main refreshed its cache
  // before publishing "done"), same transition guard as ProvidersPage.
  const previousPhase = useRef(providerOAuth.phase);
  useEffect(() => {
    if (providerOAuth.phase === "done" && previousPhase.current !== "done") reread();
    previousPhase.current = providerOAuth.phase;
  }, [providerOAuth.phase, reread]);

  // Done means at or above the harness floor, not merely installed: an
  // below-floor binary still gates features, and the updater's auto path
  // (status below) drives the same download the card would.
  const binaryDone =
    ompUpdate.installedVersion !== null &&
    compareVersions(ompUpdate.installedVersion, MIN_SUPPORTED_OMP) >= 0;
  const projectDone = (projects?.length ?? 0) > 0;
  const sessionDone = (projects ?? []).some((group) => group.sessions.length > 0);

  const { status, progress, error } = ompUpdate;
  const binaryHint =
    status === "downloading" ? (
      <>
        {`omp-ui runs its own private copy of omp (${MIN_SUPPORTED_OMP} or later).`}
        <span className="mt-1.5 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded bg-raised">
            {progress === null ? (
              <span className="block h-1 w-full animate-pulse bg-iris" />
            ) : (
              <span className="block h-1 rounded bg-iris" style={{ width: `${progress}%` }} />
            )}
          </span>
          {progress !== null && (
            <span className="text-xs tabular-nums text-ink-dim">
              {`installing — ${progress}%`}
            </span>
          )}
        </span>
      </>
    ) : status === "error" && error !== null ? (
      <>
        {`omp-ui runs its own private copy of omp (${MIN_SUPPORTED_OMP} or later).`}
        <span className="mt-0.5 block break-words text-xs text-ink-faint">{error.message}</span>
      </>
    ) : (
      `omp-ui runs its own private copy of omp (${MIN_SUPPORTED_OMP} or later).`
    );

  const pythonHint =
    python === null
      ? "Checking the Python omp will run…"
      : python.status === "ok"
        ? python.version !== null
          ? `Python ${python.version} — the eval tool is ready.`
          : python.pythonPath !== null
            ? `Interpreter at ${python.pythonPath} — the eval tool is ready.`
            : "omp reports Python execution is ready."
        : python.status === "unavailable"
          ? python.pythonPath !== null
            ? `The configured interpreter (${python.pythonPath}) is not usable. Pick another in omp settings.`
            : "No working Python interpreter. Sessions work anyway; the eval tool needs Python."
          : `This omp could not answer the Python check: ${python.error ?? ""}`;

  const firstProject = projects?.[0];
  return (
    <Modal onClose={dismiss} width="w-[34rem]" labelledBy={titleId}>
      <div className="border-b border-line px-5 pb-4 pt-5">
        <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-ink">
          Getting started
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">Four steps to your first session, plus a Python readiness check. Status updates as you go.</p>
      </div>
      <ul className="divide-y divide-line">
        <Step
          done={binaryDone}
          title="Install the omp agent binary"
          hint={binaryHint}
          action={
            <Button
              variant="solid"
              onClick={() =>
                status === "missing" || status === "error"
                  ? void downloadOmpUpdate()
                  : void checkOmpUpdate()
              }
            >
              {status === "missing" || status === "error"
                ? "Install"
                : "Check"}
            </Button>
          }
        />
        <Step
          done={providerDone}
          title="Connect a model provider"
          hint="Add an API key or sign in to a subscription."
          action={
            <Button variant="solid" onClick={() => openSettings("providers")}>
              Open provider settings
            </Button>
          }
        />
        <Step
          done={projectDone}
          title="Track a project"
          hint="Point omp-ui at the directory you want to work in."
          action={
            <Button variant="solid" onClick={() => openProjectPicker()}>
              Add project
            </Button>
          }
        />
        <Step
          done={sessionDone}
          title="Start your first session"
          hint="Native transcript, or an embedded terminal tab."
          action={
            <Button
              variant="solid"
              disabled={!projectDone || firstProject === undefined}
              onClick={() =>
                firstProject === undefined ? undefined : void newSession(firstProject.project.path)
              }
            >
              New session
            </Button>
          }
        />
        <Step
          done={python?.status === "ok"}
          title="Python for the eval tool"
          hint={pythonHint}
          action={
            <Button
              variant="solid"
              onClick={() =>
                python !== null && python.status === "unavailable"
                  ? openSettings("omp")
                  : rereadPython()
              }
            >
              {python !== null && python.status === "unavailable"
                ? "Open Python settings"
                : "Check"}
            </Button>
          }
        />
      </ul>
      <div className="flex justify-end border-t border-line px-5 py-3.5">
        <Button variant="solid" onClick={dismiss}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
