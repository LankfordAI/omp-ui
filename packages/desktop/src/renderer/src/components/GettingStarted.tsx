import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { displayMessage } from "../backend";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Button, Modal } from "./ui";
import { CheckIcon } from "./ui/icons";

/**
 * The first-run Getting started checklist (issue #623): four gates a fresh
 * install must pass — the managed omp binary, a provider credential, a
 * registered project, a first owned session — each read live from backend
 * state the app already fetches, with one working action per unmet step.
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
  const t = useT();
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
            subscriptions.some((row) => row.accounts.length > 0),
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

  // The step's own action opened Settings; when the user closes it, the keys
  // they typed there are the news this read must pick up.
  const previousSettingsPage = useRef(settingsPage);
  useEffect(() => {
    if (previousSettingsPage.current !== null && settingsPage === null) reread();
    previousSettingsPage.current = settingsPage;
  }, [settingsPage, reread]);

  // A finished subscription sign-in adds accounts (main refreshed its cache
  // before publishing "done"), same transition guard as ProvidersPage.
  const previousPhase = useRef(providerOAuth.phase);
  useEffect(() => {
    if (providerOAuth.phase === "done" && previousPhase.current !== "done") reread();
    previousPhase.current = providerOAuth.phase;
  }, [providerOAuth.phase, reread]);

  const binaryDone = ompUpdate.installedVersion !== null;
  const projectDone = (projects?.length ?? 0) > 0;
  const sessionDone = (projects ?? []).some((group) => group.sessions.length > 0);

  const { status, progress, error } = ompUpdate;
  const binaryHint =
    status === "downloading" ? (
      <>
        {t("app.gettingstarted.hintBinary")}
        <span className="mt-1.5 flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded bg-raised">
            {progress === null ? (
              <span className="block h-1 w-full animate-pulse bg-iris" />
            ) : (
              <span className="block h-1 rounded bg-iris" style={{ width: `${progress}%` }} />
            )}
          </span>
          {progress !== null && (
            <span className="text-[11px] tabular-nums text-ink-dim">
              {t("app.gettingstarted.downloading", { percent: progress })}
            </span>
          )}
        </span>
      </>
    ) : status === "error" && error !== null ? (
      <>
        {t("app.gettingstarted.hintBinary")}
        <span className="mt-0.5 block break-words text-xs text-ink-faint">{error.message}</span>
      </>
    ) : (
      t("app.gettingstarted.hintBinary")
    );

  const firstProject = projects?.[0];
  return (
    <Modal onClose={dismiss} width="w-[34rem]" labelledBy={titleId}>
      <div className="border-b border-line px-5 pb-4 pt-5">
        <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight text-ink">
          {t("app.gettingstarted.title")}
        </h2>
        <p className="mt-0.5 text-xs text-ink-dim">{t("app.gettingstarted.subtitle")}</p>
      </div>
      <ul className="divide-y divide-line">
        <Step
          done={binaryDone}
          title={t("app.gettingstarted.stepBinary")}
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
                ? t("app.gettingstarted.actionInstall")
                : t("app.gettingstarted.actionCheck")}
            </Button>
          }
        />
        <Step
          done={providerDone}
          title={t("app.gettingstarted.stepProvider")}
          hint={t("app.gettingstarted.hintProvider")}
          action={
            <Button variant="solid" onClick={() => openSettings("providers")}>
              {t("app.gettingstarted.actionOpenProviders")}
            </Button>
          }
        />
        <Step
          done={projectDone}
          title={t("app.gettingstarted.stepProject")}
          hint={t("app.gettingstarted.hintProject")}
          action={
            <Button variant="solid" onClick={() => openProjectPicker()}>
              {t("app.gettingstarted.actionAddProject")}
            </Button>
          }
        />
        <Step
          done={sessionDone}
          title={t("app.gettingstarted.stepSession")}
          hint={t("app.gettingstarted.hintSession")}
          action={
            <Button
              variant="solid"
              disabled={!projectDone || firstProject === undefined}
              onClick={() =>
                firstProject === undefined ? undefined : void newSession(firstProject.project.path)
              }
            >
              {t("app.gettingstarted.actionNewSession")}
            </Button>
          }
        />
      </ul>
      <div className="flex justify-end border-t border-line px-5 py-3.5">
        <Button variant="solid" onClick={dismiss}>
          {t("app.gettingstarted.done")}
        </Button>
      </div>
    </Modal>
  );
}
