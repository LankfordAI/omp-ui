import { useState } from "react";
import { LOCAL_MACHINE_KEY } from "@omp-ui/core/fleet";
import {
  WEBHOOK_DEFAULT_RATE_PER_HOUR,
  WEBHOOK_PATH_PREFIX,
  validateWebhookName,
  validateWebhookRate,
  validateWebhookTemplate,
  type WebhookAuth,
  type WebhookDeliveryOutcome,
  type WebhookInput,
  type WebhookMode,
  type WebhookSecretReveal,
  type WebhookSummary,
  type WebhookWorkspace,
} from "@omp-ui/core/webhook";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { useStore } from "../../store";
import { Button, ChoiceCapsule, CopyButton, Empty, Label, Panel, Switch } from "../ui";
import { FIELD, Row } from "./rows";

/**
 * Settings → Webhooks (issue #997, ADR-0075): authenticated endpoints on the
 * remote-access listener that start one session per proven request. The
 * secret crosses the wire only in create/rotate replies; this page holds it
 * in component state for the one reveal and drops it on Done.
 */

/** `${origin}/webhooks/${id}` for every listener base URL; the token query never rides along. */
export function webhookEndpoints(urls: readonly string[], id: string): string[] {
  const bases = urls.map((url) => url.split(/[?#]/)[0]!.replace(/\/+$/, ""));
  return [...new Set(bases)].map((base) => `${base}${WEBHOOK_PATH_PREFIX}${id}`);
}

const OUTCOME_LABEL: Record<WebhookDeliveryOutcome, string> = {
  started: "started",
  pending: "pending",
  unknown: "unknown",
  failed: "failed",
  unauthorized: "unauthorized",
  disabled: "disabled",
  "rate-limited": "rate-limited",
  duplicate: "duplicate",
  "bad-request": "bad request",
};

function outcomeTone(outcome: WebhookDeliveryOutcome): string {
  if (outcome === "started") return "text-signal";
  if (outcome === "pending" || outcome === "unknown") return "text-copper";
  if (outcome === "duplicate" || outcome === "disabled") return "text-ink-dim";
  return "text-rose";
}

interface ProjectChoice {
  machineKey: string;
  path: string;
  name: string;
  /** Null for this computer. */
  nickname: string | null;
}

function useProjectChoices(): ProjectChoice[] {
  const state = useStore((s) => s.state);
  const choices: ProjectChoice[] = [];
  for (const group of state?.projects ?? []) {
    choices.push({ machineKey: LOCAL_MACHINE_KEY, path: group.project.path, name: group.project.name, nickname: null });
  }
  for (const instance of state?.remoteInstances ?? []) {
    for (const group of instance.projects) {
      choices.push({
        machineKey: instance.id,
        path: group.project.path,
        name: group.project.name,
        nickname: instance.nickname,
      });
    }
  }
  return choices;
}

const choiceValue = (machineKey: string, path: string): string => JSON.stringify([machineKey, path]);

function useMachineLabel(): (machineKey: string) => string {
  const instances = useStore((s) => s.state?.remoteInstances ?? []);
  return (machineKey) =>
    machineKey === LOCAL_MACHINE_KEY
      ? "This computer"
      : (instances.find((i) => i.id === machineKey)?.nickname ?? machineKey);
}

function projectName(choices: readonly ProjectChoice[], machineKey: string, path: string): string {
  return (
    choices.find((c) => c.machineKey === machineKey && c.path === path)?.name ??
    path.split(/[\\/]/).filter(Boolean).pop() ??
    path
  );
}

/** The one-time secret panel; Done drops the secret from component state. */
function SecretReveal({ reveal, onDone }: { reveal: WebhookSecretReveal; onDone: () => void }) {
  return (
    <Panel tone="copper" className="px-4 py-3">
      <p className="text-sm font-medium text-ink">
        {`Secret for ${reveal.webhook.name}`}
      </p>
      <p className="mt-0.5 text-sm leading-relaxed text-ink-faint">Copy it now; it is not shown again.</p>
      <div className="mt-2 flex items-center gap-1.5">
        <span data-selectable data-testid="webhook-secret" className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
          {reveal.secret}
        </span>
        <CopyButton text={reveal.secret} />
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-mid">
        {reveal.webhook.auth === "hmac" ? "Set it as the webhook secret; omp-ui checks X-Hub-Signature-256." : "Send Authorization: Bearer SECRET."}
      </p>
      <div className="mt-2 flex justify-end">
        <Button size="xs" variant="solid" onClick={onDone}>
          Done
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Create (initial null) or edit form. Client-side validation uses the core
 * validators; the server's refusal lands inline beside the Save button.
 */
function WebhookForm({
  initial,
  canCreate,
  onCreated,
  onClose,
}: {
  initial: WebhookSummary | null;
  canCreate: boolean;
  onCreated?: (reveal: WebhookSecretReveal) => void;
  onClose?: () => void;
}) {
  const createWebhook = useStore((s) => s.createWebhook);
  const updateWebhook = useStore((s) => s.updateWebhook);
  const choices = useProjectChoices();
  const machineLabel = useMachineLabel();
  const [name, setName] = useState(initial?.name ?? "");
  const [project, setProject] = useState(
    initial !== null
      ? choiceValue(initial.machineKey, initial.projectCwd)
      : choices[0] !== undefined
        ? choiceValue(choices[0].machineKey, choices[0].path)
        : "",
  );
  const [template, setTemplate] = useState(initial?.template ?? "");
  const [mode, setMode] = useState<WebhookMode>(initial?.mode ?? "plan");
  const [workspace, setWorkspace] = useState<WebhookWorkspace>(initial?.workspace ?? "worktree");
  const [auth, setAuth] = useState<WebhookAuth>(initial?.auth ?? "hmac");
  const [rate, setRate] = useState(
    initial !== null
      ? initial.ratePerHour === null
        ? ""
        : String(initial.ratePerHour)
      : String(WEBHOOK_DEFAULT_RATE_PER_HOUR),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An edited webhook whose project is no longer listed keeps its option.
  const options =
    initial !== null && !choices.some((c) => c.machineKey === initial.machineKey && c.path === initial.projectCwd)
      ? [
          ...choices,
          {
            machineKey: initial.machineKey,
            path: initial.projectCwd,
            name: projectName(choices, initial.machineKey, initial.projectCwd),
            nickname: initial.machineKey === LOCAL_MACHINE_KEY ? null : machineLabel(initial.machineKey),
          },
        ]
      : choices;

  const submit = (): void => {
    if (busy) return;
    let input: WebhookInput;
    try {
      if (project === "") throw new Error("Pick a project first.");
      const [machineKey, projectCwd] = JSON.parse(project) as [string, string];
      input = {
        name: validateWebhookName(name),
        machineKey,
        projectCwd,
        template: validateWebhookTemplate(template),
        mode,
        workspace,
        auth,
        enabled,
        ratePerHour: validateWebhookRate(rate.trim() === "" ? null : Number(rate)),
      };
    } catch (err) {
      setError(displayMessage(err));
      return;
    }
    setBusy(true);
    setError(null);
    if (initial === null) {
      createWebhook(input)
        .then(
          (reveal) => {
            setName("");
            setTemplate("");
            onCreated?.(reveal);
          },
          (err: unknown) => setError(displayMessage(err)),
        )
        .finally(() => setBusy(false));
    } else {
      void updateWebhook(initial.id, input)
        .then(() => onClose?.())
        .finally(() => setBusy(false));
    }
  };

  const disabled = busy || (initial === null && !canCreate);

  return (
    <div className="divide-y divide-line-soft">
      <Row title="Name">
        <input
          type="text"
          value={name}
          aria-label="Name"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          className={cn(FIELD, "w-56")}
        />
      </Row>
      <Row title="Project">
        <select
          aria-label="Project"
          value={project}
          disabled={disabled}
          onChange={(e) => setProject(e.target.value)}
          className={cn(FIELD, "max-w-64")}
        >
          {options.length === 0 && <option value="">No projects</option>}
          {options.map((c) => (
            <option key={choiceValue(c.machineKey, c.path)} value={choiceValue(c.machineKey, c.path)}>
              {c.nickname === null ? c.name : `${c.name} — ${c.nickname}`}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Prompt template" hint="Instructions placed before the request body." stacked>
        <textarea
          value={template}
          aria-label="Prompt template"
          disabled={disabled}
          onChange={(e) => setTemplate(e.target.value)}
          className={cn(FIELD, "h-20 w-full resize-y py-1.5")}
        />
      </Row>
      <Row title="Mode" hint="Plan keeps a payload from editing files before you approve.">
        <ChoiceCapsule
          label="Mode"
          value={mode}
          options={[
            { value: "plan", label: "Plan" },
            { value: "build", label: "Build" },
          ] as const}
          onChange={setMode}
          optionClassName="tab-label px-2"
        />
      </Row>
      <Row title="Workspace">
        <ChoiceCapsule
          label="Workspace"
          value={workspace}
          options={[
            { value: "worktree", label: "New worktree" },
            { value: "checkout", label: "Project checkout" },
          ] as const}
          onChange={setWorkspace}
          optionClassName="tab-label px-2"
        />
      </Row>
      <Row title="Authentication">
        <ChoiceCapsule
          label="Authentication"
          value={auth}
          options={[
            { value: "hmac", label: "GitHub signature (HMAC)" },
            { value: "bearer", label: "Bearer token" },
          ] as const}
          onChange={setAuth}
          optionClassName="tab-label px-2"
        />
      </Row>
      <Row title="Rate limit per hour" hint="Empty means only the app-wide ceiling applies.">
        <input
          type="number"
          min={1}
          value={rate}
          aria-label="Rate limit per hour"
          disabled={disabled}
          onChange={(e) => setRate(e.target.value)}
          className={cn(FIELD, "w-24")}
        />
      </Row>
      <Row title="Enabled">
        <Switch on={enabled} onChange={setEnabled} label="Enabled" />
      </Row>
      <div className="flex items-center gap-3 py-2.5">
        {error !== null && (
          <p role="alert" className="min-w-0 flex-1 text-sm leading-relaxed text-rose">
            {error}
          </p>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {onClose !== undefined && (
            <Button size="xs" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button variant="solid" size="xs" disabled={disabled} onClick={submit}>
            {initial === null
              ? busy
                ? "Creating…"
                : "Create"
              : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function WebhookPanel({
  webhook,
  onRotated,
}: {
  webhook: WebhookSummary;
  onRotated: (reveal: WebhookSecretReveal) => void;
}) {
  const remote = useStore((s) => s.remote);
  const updateWebhook = useStore((s) => s.updateWebhook);
  const rotateWebhookSecret = useStore((s) => s.rotateWebhookSecret);
  const removeWebhook = useStore((s) => s.removeWebhook);
  const credentialStore = useStore((s) => s.webhooks.credentialStore);
  const choices = useProjectChoices();
  const machineLabel = useMachineLabel();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listening = remote.status === "listening";
  const endpoints = listening ? webhookEndpoints(remote.urls, webhook.id) : [];
  const path = `${WEBHOOK_PATH_PREFIX}${webhook.id}`;

  const rotate = (): void => {
    setRotating(true);
    setError(null);
    rotateWebhookSecret(webhook.id)
      .then(onRotated, (err: unknown) => setError(displayMessage(err)))
      .finally(() => setRotating(false));
  };

  const facts = [
    webhook.mode === "plan" ? "Plan" : "Build",
    webhook.workspace === "worktree" ? "New worktree" : "Project checkout",
    webhook.auth === "hmac" ? "GitHub signature (HMAC)" : "Bearer token",
    webhook.ratePerHour === null
      ? "No per-webhook limit"
      : `${webhook.ratePerHour} per hour`,
  ];

  return (
    <Panel className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{webhook.name}</p>
          <p className="mt-0.5 truncate text-xs text-ink-mid">
            {`${projectName(choices, webhook.machineKey, webhook.projectCwd)} on ${machineLabel(webhook.machineKey)}`}
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">{facts.join(" · ")}</p>
        </div>
        <Switch
          on={webhook.enabled}
          onChange={(next) => void updateWebhook(webhook.id, { enabled: next })}
          label={`enable webhook ${webhook.name}`}
        />
      </div>
      <div className="mt-2 space-y-0.5">
        {endpoints.length > 0 ? (
          endpoints.map((url) => (
            <div key={url} className="flex items-center gap-1.5">
              <span data-selectable className="min-w-0 flex-1 truncate font-mono text-xs text-ink-mid" title={url}>
                {url}
              </span>
              <CopyButton text={url} />
            </div>
          ))
        ) : (
          <p data-selectable className="truncate font-mono text-xs text-ink-faint" title={path}>
            {path}
          </p>
        )}
      </div>
      {!webhook.secretReadable && (
        <p className="mt-1.5 text-sm leading-relaxed text-rose">Secret unreadable — rotate it. Every delivery is refused until then.</p>
      )}
      {error !== null && (
        <p role="alert" className="mt-1.5 text-sm leading-relaxed text-rose">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Edit"}
        </Button>
        <Button size="xs" variant="ghost" disabled={rotating || !credentialStore} onClick={rotate}>
          Rotate secret
        </Button>
        {confirmingDelete ? (
          <>
            <Button size="xs" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button size="xs" variant="solid" tone="rose" onClick={() => void removeWebhook(webhook.id)}>
              Delete webhook
            </Button>
          </>
        ) : (
          <Button size="xs" variant="ghost" tone="rose" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-2 border-t border-line-soft pt-1">
          <WebhookForm initial={webhook} canCreate={credentialStore} onClose={() => setEditing(false)} />
        </div>
      )}
    </Panel>
  );
}

function Deliveries() {
  const deliveries = useStore((s) => s.webhooks.deliveries);
  const clearWebhookDeliveries = useStore((s) => s.clearWebhookDeliveries);
  const openSession = useStore((s) => s.openSession);
  const newestFirst = [...deliveries].reverse();

  return (
    <div>
      <div className="flex items-center gap-2">
        <Label>Recent deliveries</Label>
        {deliveries.length > 0 && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => void clearWebhookDeliveries()}>
            Clear
          </Button>
        )}
      </div>
      {newestFirst.length === 0 ? (
        <p className="mt-1 text-xs text-ink-faint">No deliveries yet.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line-soft">
          {newestFirst.map((d) => (
            <li key={d.id} className="flex items-start gap-3 py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink">
                  <span className="text-ink-faint">{new Date(d.at).toLocaleString("en")}</span>
                  {" · "}
                  {d.webhookName}
                  {d.event !== null && <span className="font-mono text-ink-mid">{` · ${d.event}`}</span>}
                </p>
                <p className="truncate text-ink-faint">
                  <span className={outcomeTone(d.outcome)}>{OUTCOME_LABEL[d.outcome]}</span>
                  {` · HTTP ${d.status} · ${`${d.bytes} bytes`}`}
                  {d.message !== null && ` · ${d.message}`}
                </p>
              </div>
              {d.outcome === "started" && d.tabId !== null && d.machineKey === LOCAL_MACHINE_KEY && (
                <Button size="xs" variant="ghost" onClick={() => void openSession(d.tabId!)}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function WebhooksPage() {
  const webhooks = useStore((s) => s.webhooks);
  const remoteStatus = useStore((s) => s.remote.status);
  const setWebhooksEnabled = useStore((s) => s.setWebhooksEnabled);
  const openSettings = useStore((s) => s.openSettings);
  // The one place a secret lives in the renderer: dropped on Done (ADR-0075).
  const [reveal, setReveal] = useState<WebhookSecretReveal | null>(null);

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-sm leading-relaxed text-ink-faint">Each webhook is an endpoint on the remote-access listener. A request that proves the webhook's secret starts one session with the prompt template, plus the request body marked as untrusted data.</p>
      <p className="text-sm leading-relaxed text-copper">Anyone holding a secret can start sessions on that project. Keep the listener behind HTTPS and forward only /webhooks/.</p>

      <div className="divide-y divide-line-soft">
        <Row title="Accept webhooks" hint="While off, /webhooks/ is not a route: requests get the same 401 as any unauthenticated path.">
          <Switch
            on={webhooks.enabled}
            onChange={(next) => void setWebhooksEnabled(next)}
            label="Accept webhooks"
          />
        </Row>
      </div>
      {remoteStatus !== "listening" && (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-copper">Webhooks need remote access running; nothing reaches them until the listener is up.</p>
          <Button size="xs" onClick={() => openSettings("remote")}>
            Open Remote access
          </Button>
        </div>
      )}
      {!webhooks.credentialStore && (
        <p className="text-sm leading-relaxed text-rose">No OS credential store is available, so webhooks cannot be created or rotated.</p>
      )}

      {reveal !== null && <SecretReveal reveal={reveal} onDone={() => setReveal(null)} />}

      {webhooks.webhooks.length === 0 ? (
        <Empty title="No webhooks yet" hint="Create one below; its secret is shown once." />
      ) : (
        <div className="space-y-2">
          {webhooks.webhooks.map((webhook) => (
            <WebhookPanel key={webhook.id} webhook={webhook} onRotated={setReveal} />
          ))}
        </div>
      )}

      <div>
        <Label>Create webhook</Label>
        <WebhookForm initial={null} canCreate={webhooks.credentialStore} onCreated={setReveal} />
      </div>

      <Deliveries />
    </div>
  );
}
