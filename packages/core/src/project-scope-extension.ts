import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";
import { hiddenContextArmMessage, hiddenContextExtensionSource } from "./hidden-context-extension";

/**
 * Project scope guidance (#1226, ADR-0098): one hidden custom message telling
 * a native project session to make repository changes only inside its own
 * checkout, and where other repositories' work goes instead (a dispatched
 * session, the dispatching session, or the user). The main process arms it at
 * protocol readiness from the same fleet tool access value that registers the
 * fleet tools.
 *
 * Unlike the Ask pin, the text changes when the checkout or role changes
 * (worktree convert/release, fork, migration), so the bridge dedupes on
 * content: it sends only when the latest project scope message on the branch
 * is absent or differs. Every text opens by saying it replaces any earlier one.
 * Guidance, not enforcement.
 */

export const PROJECT_SCOPE_COMMAND = "omp-ui-project-scope";
export const PROJECT_SCOPE_CUSTOM_TYPE = "omp-ui:project-scope";
export const PROJECT_SCOPE_TEXT_MAX = 4_000;
/** The extension file lives beside the transcript so it dies with the lineage. */
const EXTENSION = "omp-ui-project-scope.ts";

export function projectScopeExtensionPath(lineageDir: string): string {
  return path.join(lineageDir, EXTENSION);
}

/** Rewritten on every rpc spawn, like every generated bridge. */
export function writeProjectScopeExtension(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    projectScopeExtensionPath(lineageDir),
    hiddenContextExtensionSource({
      command: PROJECT_SCOPE_COMMAND,
      customType: PROJECT_SCOPE_CUSTOM_TYPE,
      textMax: PROJECT_SCOPE_TEXT_MAX,
      label: "omp-ui project scope",
      resendOn: ["session_compact", "session_branch", "session_switch"],
      dedupe: "content",
    }),
  );
}

/** The hidden slash command the spawner pushes ahead of the readiness commands. */
export function projectScopeArmMessage(text: string): string {
  return hiddenContextArmMessage(PROJECT_SCOPE_COMMAND, text);
}

/**
 * - `dispatch`: the session may dispatch other repositories' work (fleet tools granted, not private).
 * - `report-to-parent`: an agent-dispatched session; it reports other repositories' needs back.
 * - `report-to-user`: a private session with the fleet tools; it never hands its context to a dispatched session.
 */
export type ProjectScopeRole = "dispatch" | "report-to-parent" | "report-to-user";

export interface ProjectScopeInput {
  projectName: string;
  projectCwd: string;
  /** record.worktree?.path ?? record.projectCwd */
  checkoutPath: string;
  role: ProjectScopeRole;
}

const LOCATION_FALLBACK =
  "This session belongs to one omp-ui project; its working directory is that project's checkout.";

const ROLE_TEXT: Record<ProjectScopeRole, string> = {
  dispatch: [
    "When the work also needs changes in another repository, do not edit that repository from this session. Dispatch the change instead: call omp-ui_fleet_machines to find the other project's absolute path on this computer (or its repository key), then call omp-ui_fleet_dispatch once per repository with that project, a short title, and a self-contained prompt that states exactly what to change there and why. The dispatched session cannot see this conversation. Leave machines out unless the user names a machine.",
    "Read each dispatch result. When it reports a started session, finish this repository's part and end your turn: omp-ui posts a Fleet result into this session when that session finishes its first run, so do not poll. When it reports a failure, tell the user the dispatch failed and what the other repository still needs. When the outcome is unknown, tell the user and do not dispatch the same work again.",
    "While this session is in Plan mode, do not dispatch implementation work: describe the other repository's change in your plan instead. Dispatch only when the user asks for planning in another repository, and then pass planMode true with a prompt that asks for a plan.",
    "If the other repository is not a registered omp-ui project, or omp-ui_fleet_dispatch is not available in this session, tell the user what needs to change there and do not edit it from this session.",
  ].join("\n\n"),
  "report-to-parent":
    "Another session dispatched this one to change this project only. If the work also needs changes in another repository, do not edit that repository and do not try to dispatch it. Finish the work in this project, then begin your final reply with the other repository's name and the exact change it needs, in a few lines, before anything else: omp-ui forwards only the first 2,000 characters of that reply to the session that dispatched you, and only after your first run. If you find the need in a later turn, tell the user instead.",
  "report-to-user":
    "This is a private session, so do not dispatch work to other sessions and do not edit other repositories. When the work also needs changes in another repository, finish this project's part and tell the user what the other repository needs.",
};

function opening(location: string): string {
  return `omp-ui project scope. This replaces any earlier omp-ui project scope message. ${location} Make repository changes only inside that checkout. Reading other repositories for context is fine, and this rule does not limit session artifacts (local://) or the omp-ui vault tools, which follow their own rules.`;
}

/**
 * Model-facing guidance. Never exceeds PROJECT_SCOPE_TEXT_MAX: when the full
 * text is too long (a very long path or name), the location sentence falls
 * back to LOCATION_FALLBACK and the role paragraphs stay intact.
 */
export function projectScopeGuidance(input: ProjectScopeInput): string {
  const checkout = input.checkoutPath === input.projectCwd ? "" : `, working in the checkout ${input.checkoutPath}`;
  const location = `This session belongs to the project "${input.projectName}" at ${input.projectCwd}${checkout}.`;
  const role = ROLE_TEXT[input.role];
  const full = `${opening(location)}\n\n${role}`;
  if (full.length <= PROJECT_SCOPE_TEXT_MAX) return full;
  return `${opening(LOCATION_FALLBACK)}\n\n${role}`;
}
