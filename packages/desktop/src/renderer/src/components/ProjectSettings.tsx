import { useEffect, useMemo, useRef, useState } from "react";
import { parseModelRole } from "@omp-ui/core/model-role";
import type { ProjectRecord } from "@omp-ui/core/types";
import { cn } from "../lib/cn";
import type { ModelInfo } from "../lib/rpc-types";
import { projectKey } from "../lib/project-key";
import { findInstance, useStore } from "../store";
import { McpServersPanel, SkillsScopePanel, ToolsScopePanel } from "./CapabilitiesViewer";
import { AdvisorRosterEditor } from "./AdvisorRoster";
import { ModelPalette } from "./ModelSelector";
import { KnowledgeHomeSection } from "./KnowledgeHomeSection";
import { ProjectIconSection } from "./ProjectIconSection";
import { CouncilRosterEditor } from "./CouncilRoster";
import { Button, Label, Modal, Switch } from "./ui";

/**
 * The project's standing model pins (issue #257): the default main model and
 * the default advisor model that every fresh session in the project boots
 * with, ahead of the last-used memory.
 *
 * A pin is a standing choice, not memory — composer changes keep writing
 * `lastModel`/`lastAdvisorModel` and never move a pin. The advisor pin is a
 * model value only: advisor on/off keeps its own chain (issue #174), so a pin
 * is dormant while that chain resolves off, and the section says so instead of
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
            <p className="text-xs leading-snug text-rose" role="alert">
              {draftError}
            </p>
          ) : (
            <p className="text-xs text-ink-faint">leave empty to clear the pin</p>
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

/**
 * The project's standing model pins (issue #257): default main + advisor model
 * with pickers and Clear. Extracted from the project defaults sheet into the
 * merged Project settings dialog (issue #281). Catalog behavior unchanged:
 * fed from a live session's availableModels, typed input is the fallback.
 */
export function ProjectModelPins({
  project,
  instanceId = null,
}: {
  project: ProjectRecord;
  /** The remote instance owning the project (issue #416); null for this host. */
  instanceId?: string | null;
}) {
  const state = useStore((s) => s.state);
  const rpc = useStore((s) => s.rpc);
  const advisorDefaults = useStore((s) => s.advisorDefaults);
  const loadAdvisorDefaults = useStore((s) => s.loadAdvisorDefaults);
  const setProjectDefaultModel = useStore((s) => s.setProjectDefaultModel);
  const setProjectDefaultAdvisorModel = useStore((s) => s.setProjectDefaultAdvisorModel);

  const projectPath = project.path;

  // omp's config supplies the advisor fallback and the effective on/off state.
  useEffect(() => {
    void loadAdvisorDefaults(projectPath, instanceId);
  }, [projectPath, instanceId, loadAdvisorDefaults]);

  // Transient UI dies with the dialog (or the project — a removed project
  // unmounts it via App's lookup).
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
    const groups = instanceId === null ? state?.projects : findInstance(state, instanceId)?.projects;
    const group = groups?.find((g) => g.project.path === projectPath) ?? null;
    if (group === null) return EMPTY;
    for (const session of group.sessions) {
      if (session.live !== "live") continue;
      const list = rpc[session.tabId]?.availableModels;
      if (list !== undefined && list.length > 0) return list;
    }
    return EMPTY;
  }, [state, rpc, projectPath, instanceId]);

  const mainPin = project.defaultModel ?? null;
  const advisorPin = project.defaultAdvisorModel ?? null;
  const defaults = advisorDefaults[projectKey(instanceId, projectPath)];
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
    if (editing === null) return;
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
    if (editing === "main") void setProjectDefaultModel(projectPath, selector, instanceId);
    else void setProjectDefaultAdvisorModel(projectPath, selector, instanceId);
    setEditing(null);
  };

  const mainCurrent =
    mainPin === null
      ? null
      : models.find((m) => `${m.provider}/${m.id}` === mainPin) ?? null;

  return (
    <>
      <div className="space-y-5">
        <PinField
          label="Default model"
          pin={mainPin}
          notSet={
            <>
              not set — new sessions use the last-used model, then omp's default
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
          onClear={() => void setProjectDefaultModel(project.path, null, instanceId)}
        />

        <PinField
          label="Default advisor model"
          pin={advisorPin}
          notSet={
            <>
              not set — last-used, then omp's{" "}
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
          onClear={() => void setProjectDefaultAdvisorModel(project.path, null, instanceId)}
        />

        {/* The pin is a model value only: while the on/off chain resolves
            off, the pin is dormant — say so, never hide it. */}
        {advisorPin !== null && advisorStartsOn === false && (
          <p className="rounded-md border border-copper-dim/50 bg-copper-wash px-3 py-2 text-xs leading-snug text-copper">
            The advisor starts off for new sessions (last-used off / app default) — the pinned model applies whenever the advisor is on.
          </p>
        )}

        <p className="text-xs leading-snug text-ink-faint">
          Pins seed new sessions only. Switching models in a running session updates the last-used memory, never the pin.
        </p>
      </div>

      {picking === "main" && models.length > 0 && (
        <ModelPalette
          variant="main"
          models={models}
          current={mainCurrent}
          instanceId={instanceId}
          onClose={() => setPicking(null)}
          onPick={(model) => {
            setPicking(null);
            void setProjectDefaultModel(project.path, `${model.provider}/${model.id}`, instanceId);
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
          instanceId={instanceId}
          onClose={() => setPicking(null)}
          onPick={(selector) => {
            setPicking(null);
            // A null pick ("use omp's configured advisor") clears the pin —
            // defer-to-config is exactly the no-pin semantics.
            void setProjectDefaultAdvisorModel(project.path, selector, instanceId);
          }}
        />
      )}
    </>
  );
}

export type ProjectSettingsSectionId =
  | "mcp"
  | "skills"
  | "tools"
  | "models"
  | "advisors"
  | "council"
  | "browser"
  | "knowledge"
  | "icon";

const SECTIONS: { id: ProjectSettingsSectionId; label: string }[] = [
  { id: "mcp", label: "MCP servers" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Tools" },
  { id: "models", label: "Default models" },
  { id: "advisors", label: "Advisors" },
  { id: "council", label: "Council" },
  { id: "browser", label: "Browser" },
  { id: "knowledge", label: "Knowledge" },
  { id: "icon", label: "Icon" },
];

/**
 * The per-project settings dialog (issues #281, #383, #564): one modal holding
 * a project's standing configuration — MCP servers, the skills and tools
 * catalogs at project scope, the default-model pins, the advisor roster (WATCHDOG.yml), the
 * council roster (app state, ADR-0088, issue #1049, hidden unless the
 * council flag is on), the browser clock, the Knowledge home
 * (`ProjectRecord.knowledgeHome`, stored in omp-ui's registry), and the
 * project icon (`ProjectRecord.icon`, issue #1000) — behind a nine-tab strip,
 * opened from the desktop project header and the
 * compact actions sheet. Session-scoped behavior (rosters, session-local
 * switches, restart, TUI reauth handoff) stays in CapabilitiesViewer; this
 * dialog pins no session tab, so every panel gets only the project scope —
 * omitted viewer props keep each panel exactly the manager it always was.
 * Catalog switches write this project's `.omp/config.yml` in place
 * (core/project-config-writer.ts); the browser clock is an omp-ui project
 * flag stored in omp-ui's registry (`ProjectRecord.browserClock`), not in
 * `.omp/config.yml`. The active tab is dialog-local state, resetting to MCP
 * servers on each open.
 */
export function ProjectSettings({
  project,
  instanceId = null,
  onClose,
  initialSection,
}: {
  /** Tab to open on; defaults to MCP servers. */
  initialSection?: ProjectSettingsSectionId;
  /** `null` renders nothing — removal auto-close is enforced by App's lookup. */
  project: ProjectRecord | null;
  /** The remote instance owning the project (issue #416); null for this host. */
  instanceId?: string | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState<ProjectSettingsSectionId>(initialSection ?? "mcp");
  const tabRefs = useRef<Partial<Record<ProjectSettingsSectionId, HTMLButtonElement | null>>>({});
  const setProjectBrowserClock = useStore((s) => s.setProjectBrowserClock);
  const councilEnabled = useStore((s) => s.state?.councilEnabled === true);
  const sections = councilEnabled ? SECTIONS : SECTIONS.filter((tab) => tab.id !== "council");

  // WAI-ARIA tabs: roving tabindex, arrows/Home/End move selection AND focus.
  // Mirrors CapabilitiesViewer's onTabListKeyDown (CapabilitiesViewer.tsx).
  const onTabListKeyDown = (event: React.KeyboardEvent): void => {
    const index = sections.findIndex((tab) => tab.id === active);
    const target =
      event.key === "ArrowRight" ? (index + 1) % sections.length
        : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length
          : event.key === "Home" ? 0
            : event.key === "End" ? sections.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = sections[target]!;
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  };

  if (project === null) return null;

  return (
    <Modal onClose={onClose} width="w-[44rem]" labelledBy="project-settings-title">
      <section>
        <header className="border-b border-line px-4 py-3.5">
          <p className="mb-1 chrome-label text-ink-faint">
            Project settings
          </p>
          <h2 id="project-settings-title" className="text-base font-semibold text-ink">
            {project.name}
          </h2>
          <p title={project.path} className="mt-1 truncate font-mono text-xs text-ink-dim">
            {project.path}
          </p>
        </header>

        <div
          role="tablist"
          aria-label="Project settings"
          onKeyDown={onTabListKeyDown}
          className="flex flex-wrap gap-1 border-b border-line px-4 py-2"
        >
          {sections.map((tab) => {
            const selected = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[tab.id] = node;
                }}
                type="button"
                role="tab"
                id={`project-settings-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`project-settings-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(tab.id)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  selected ? "bg-hover text-ink" : "text-ink-mid hover:text-ink",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`project-settings-panel-${active}`}
          aria-labelledby={`project-settings-tab-${active}`}
          tabIndex={-1}
          className="max-h-[60dvh] overflow-y-auto"
        >
          {active === "mcp" && (
            <section aria-labelledby="project-settings-mcp" className="pb-3">
              <h3 id="project-settings-mcp" className="px-4 pt-4 text-sm font-semibold text-ink">
                MCP servers
              </h3>
              {/* A project dialog pins no session, so the project root is the
                  scope — no checkout to resolve through. */}
              <McpServersPanel scopeCwd={project.path} instanceId={instanceId} />
              <p className="px-4 pt-2 text-xs text-ink-faint">
                Changes apply to new sessions in this project.
              </p>
            </section>
          )}

          {active === "skills" && (
            <section aria-labelledby="project-settings-skills" className="pb-3">
              <h3 id="project-settings-skills" className="px-4 pt-4 text-sm font-semibold text-ink">
                Skills
              </h3>
              <SkillsScopePanel scopeCwd={project.path} instanceId={instanceId} />
              <p className="px-4 pt-2 text-xs text-ink-faint">
                Files and settings at this project's scope — switches write .omp/config.yml here; changes apply to sessions started afterwards.
              </p>
            </section>
          )}

          {active === "tools" && (
            <section aria-labelledby="project-settings-tools" className="pb-3">
              <h3 id="project-settings-tools" className="px-4 pt-4 text-sm font-semibold text-ink">
                Tools
              </h3>
              <ToolsScopePanel scopeCwd={project.path} instanceId={instanceId} />
              <p className="px-4 pt-2 text-xs text-ink-faint">
                Tool enable settings for this project's scope; they apply to sessions started afterwards.
              </p>
            </section>
          )}

          {active === "models" && (
            <section aria-labelledby="project-settings-models" className="px-4 py-4">
              <h3 id="project-settings-models" className="mb-4 text-sm font-semibold text-ink">
                Default models
              </h3>
              <ProjectModelPins project={project} instanceId={instanceId} />
            </section>
          )}

          {active === "advisors" && (
            <section aria-labelledby="project-settings-advisors" className="pb-3">
              <h3 id="project-settings-advisors" className="px-4 pt-4 text-sm font-semibold text-ink">
                Advisors
              </h3>
              <AdvisorRosterEditor scopeCwd={project.path} instanceId={instanceId} />
              <p className="px-4 pt-2 text-xs text-ink-faint">Edits omp's WATCHDOG.yml. Running sessions pick up changes on restart.</p>
            </section>
          )}

          {active === "council" && councilEnabled && (
            <section aria-labelledby="project-settings-council" className="pb-3">
              <h3 id="project-settings-council" className="px-4 pt-4 text-sm font-semibold text-ink">
                Council
              </h3>
              <CouncilRosterEditor scopeCwd={project.path} instanceId={instanceId} />
              <p className="px-4 pt-2 text-xs text-ink-faint">Stored in omp-ui's own state, per project. /council asks these members; running sessions pick up changes on restart.</p>
            </section>
          )}

          {active === "browser" && (
            <section aria-labelledby="project-settings-browser" className="px-4 py-4">
              <h3 id="project-settings-browser" className="mb-3 text-sm font-semibold text-ink">
                Browser
              </h3>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">Clock</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
                    Shows the date and time above this project's browser pane and stamps it onto every browser screenshot — the camera button, element picks, and screenshots the agent takes.
                  </p>
                </div>
                <Switch
                  on={project.browserClock === true}
                  label="Clock"
                  onChange={(next) => void setProjectBrowserClock(project.path, next, instanceId)}
                />
              </div>
            </section>
          )}

          {active === "knowledge" && <KnowledgeHomeSection project={project} instanceId={instanceId} />}

          {active === "icon" && <ProjectIconSection project={project} instanceId={instanceId} />}
        </div>
      </section>
    </Modal>
  );
}