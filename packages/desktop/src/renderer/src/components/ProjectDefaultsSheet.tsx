import { useEffect, useMemo, useState } from "react";
import { parseModelRole } from "@omp-ui/core/model-role";
import type { ProjectRecord } from "@omp-ui/core/types";
import type { ModelInfo } from "../lib/rpc-types";
import { useStore } from "../store";
import { Button, Label, Sheet } from "./ui";
import { ModelPalette } from "./ModelSelector";

/**
 * The project's standing model pins (issue #257): the default main model and
 * the default advisor model that every fresh session in the project boots
 * with, ahead of the last-used memory.
 *
 * A pin is a standing choice, not memory — composer changes keep writing
 * `lastModel`/`lastAdvisorModel` and never move a pin. The advisor pin is a
 * model value only: advisor on/off keeps its own chain (issue #174), so a pin
 * is dormant while that chain resolves off, and the sheet says so instead of
 * hiding it.
 *
 * Catalog: there is no global model list — `get_available_models` is an RPC
 * answered by a live process — so the palette is fed from a live session's
 * `availableModels` in this project, and the typed selector input below is
 * the fallback, not the exception.
 */

/** Stable empty list so the catalog memo stays referentially stable. */
const EMPTY: ModelInfo[] = [];

type Field = "main" | "advisor";

/** Typed-input validation for the main pin: `provider/id`, no `:level`. */
function validateMainPin(value: string): string | null {
  const role = parseModelRole(value);
  if (role === null || !role.model.includes("/"))
    return "use provider/model-id — omp's selectors name the provider";
  if (role.level !== undefined)
    return "use provider/id — the thinking level follows last-used memory";
  return null;
}

/** Typed-input validation for the advisor pin: `provider/id`, `:level` kept. */
function validateAdvisorPin(value: string): string | null {
  const role = parseModelRole(value);
  if (role === null || !role.model.includes("/"))
    return "use provider/model-id — omp's selectors name the provider";
  return null;
}

/** One pin's chip display or typed editor. */
function PinField({
  label,
  pin,
  notSet,
  editing,
  draft,
  draftError,
  placeholder,
  onDraftChange,
  onBeginChange,
  onSubmit,
  onCancel,
  onClear,
}: {
  label: string;
  pin: string | null;
  /** What resolves for new sessions while the pin is unset. */
  notSet: React.ReactNode;
  editing: boolean;
  draft: string;
  draftError: string | null;
  placeholder: string;
  onDraftChange(value: string): void;
  onBeginChange(): void;
  onSubmit(): void;
  onCancel(): void;
  onClear(): void;
}) {
  return (
    <section className="space-y-1.5" data-field={label}>
      <Label>{label}</Label>
      {editing ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              placeholder={placeholder}
              aria-label={label}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
                else if (event.key === "Escape") onCancel();
              }}
              className="h-9 min-w-0 flex-1 rounded-md border border-line bg-void px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            <Button size="xs" variant="solid" onClick={onSubmit}>
              Set
            </Button>
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          {draftError !== null ? (
            <p className="text-[11px] leading-snug text-rose" role="alert">
              {draftError}
            </p>
          ) : (
            <p className="text-[11px] text-ink-faint">leave empty to clear the pin</p>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
            {pin !== null ? (
              <span className="text-ink">{pin}</span>
            ) : (
              <span className="text-ink-dim">{notSet}</span>
            )}
          </p>
          <Button size="xs" onClick={onBeginChange}>
            Change
          </Button>
          {pin !== null && (
            <Button size="xs" tone="rose" onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function ProjectDefaultsSheet({
  project,
  onClose,
}: {
  /** `null` renders a closed Sheet. */
  project: ProjectRecord | null;
  onClose: () => void;
}) {
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const advisorDefaults = useStore((s) => s.advisorDefaults);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const setProjectDefaultModel = useStore((s) => s.setProjectDefaultModel);
  const setProjectDefaultAdvisorModel = useStore((s) => s.setProjectDefaultAdvisorModel);

  const projectPath = project?.path ?? null;

  // omp's config supplies the advisor fallback and the effective on/off state.
  useEffect(() => {
    if (projectPath !== null) void loadAdvisorDefaults(projectPath);
  }, [projectPath, loadAdvisorDefaults]);

  // Transient UI dies with the sheet (or the project — a removed project
  // closes it via the lookup at the call site).
  const [picking, setPicking] = useState<Field | null>(null);
  const [editing, setEditing] = useState<Field | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => {
    setPicking(null);
    setEditing(null);
    setDraft("");
    setDraftError(null);
  }, [projectPath]);

  // A live session's catalog is all the model list that exists; the first
  // non-empty one wins.
  const models = useMemo(() => {
    const group =
      projectPath === null
        ? null
        : state?.projects.find((g) => g.project.path === projectPath) ?? null;
    if (group === null) return EMPTY;
    for (const session of group.sessions) {
      if (session.live !== "live") continue;
      const list = rpc[session.tabId]?.availableModels;
      if (list !== undefined && list.length > 0) return list;
    }
    return EMPTY;
  }, [state, rpc, projectPath]);

  if (project === null) {
    return (
      <Sheet open={false} placement="right" label="default models" onClose={onClose}>
        {null}
      </Sheet>
    );
  }

  const mainPin = project.defaultModel ?? null;
  const advisorPin = project.defaultAdvisorModel ?? null;
  const defaults = projectPath === null ? undefined : advisorDefaults[projectPath];
  const configuredAdvisor = defaults?.model ?? null;
  // The advisor on/off chain, untouched by the pin (issue #174): last-used →
  // app default → omp config.
  const advisorStartsOn =
    project.lastAdvisor ?? state?.defaultAdvisor ?? defaults?.enabled ?? false;

  const beginChange = (field: Field) => {
    if (models.length > 0) {
      setEditing(null);
      setPicking(field);
      return;
    }
    setPicking(null);
    setDraft(field === "main" ? (mainPin ?? "") : (advisorPin ?? ""));
    setDraftError(null);
    setEditing(field);
  };

  const submitDraft = () => {
    if (projectPath === null || editing === null) return;
    const trimmed = draft.trim();
    if (trimmed !== "") {
      const problem =
        editing === "main" ? validateMainPin(trimmed) : validateAdvisorPin(trimmed);
      if (problem !== null) {
        setDraftError(problem);
        return;
      }
    }
    const selector = trimmed === "" ? null : trimmed;
    if (editing === "main") void setProjectDefaultModel(projectPath, selector);
    else void setProjectDefaultAdvisorModel(projectPath, selector);
    setEditing(null);
  };

  const mainCurrent =
    mainPin === null
      ? null
      : models.find((m) => `${m.provider}/${m.id}` === mainPin) ?? null;

  return (
    <>
      <Sheet
        open
        placement="right"
        label={`default models — ${project.name}`}
        onClose={onClose}
      >
        <div className="space-y-5 px-4 py-4">
          <div>
            <p className="font-display text-sm font-semibold text-ink">{project.name}</p>
            <p className="break-all font-mono text-[11px] text-ink-faint">{project.path}</p>
          </div>

          <PinField
            label="Default model"
            pin={mainPin}
            notSet={
              <>
                not set — new sessions use the last-used model, then omp&apos;s default
              </>
            }
            editing={editing === "main"}
            draft={draft}
            draftError={draftError}
            placeholder="provider/model-id"
            onDraftChange={(value) => {
              setDraft(value);
              setDraftError(null);
            }}
            onBeginChange={() => beginChange("main")}
            onSubmit={submitDraft}
            onCancel={() => setEditing(null)}
            onClear={() => void setProjectDefaultModel(project.path, null)}
          />

          <PinField
            label="Default advisor model"
            pin={advisorPin}
            notSet={
              <>
                not set — last-used, then omp&apos;s{" "}
                <span className="font-mono">modelRoles.advisor</span>
                {project.lastAdvisorModel === null && configuredAdvisor !== null && (
                  <>
                    {" "}
                    (<span className="font-mono">{configuredAdvisor}</span>)
                  </>
                )}
              </>
            }
            editing={editing === "advisor"}
            draft={draft}
            draftError={draftError}
            placeholder="provider/model-id[:level]"
            onDraftChange={(value) => {
              setDraft(value);
              setDraftError(null);
            }}
            onBeginChange={() => beginChange("advisor")}
            onSubmit={submitDraft}
            onCancel={() => setEditing(null)}
            onClear={() => void setProjectDefaultAdvisorModel(project.path, null)}
          />

          {/* The pin is a model value only: while the on/off chain resolves
              off, the pin is dormant — say so, never hide it. */}
          {advisorPin !== null && advisorStartsOn === false && (
            <p className="rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-[11px] leading-snug text-copper">
              The advisor starts off for new sessions (last-used off / app
              default) — the pinned model applies whenever the advisor is on.
            </p>
          )}

          <p className="text-[11px] leading-snug text-ink-faint">
            Pins seed new sessions only. Switching models in a running session
            updates the last-used memory, never the pin.
          </p>
        </div>
      </Sheet>

      {picking === "main" && models.length > 0 && (
        <ModelPalette
          variant="main"
          models={models}
          current={mainCurrent}
          onClose={() => setPicking(null)}
          onPick={(model) => {
            setPicking(null);
            void setProjectDefaultModel(project.path, `${model.provider}/${model.id}`);
          }}
        />
      )}
      {picking === "advisor" && models.length > 0 && (
        <ModelPalette
          variant="advisor"
          models={models}
          current={advisorPin}
          inherited={advisorPin === null}
          defaultModel={defaults?.model ?? null}
          onClose={() => setPicking(null)}
          onPick={(selector) => {
            setPicking(null);
            // A null pick ("use omp's configured advisor") clears the pin —
            // defer-to-config is exactly the no-pin semantics.
            void setProjectDefaultAdvisorModel(project.path, selector);
          }}
        />
      )}
    </>
  );
}
