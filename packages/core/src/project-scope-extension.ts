import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";
import { hiddenContextArmMessage, hiddenContextExtensionSource } from "./hidden-context-extension";

/**
 * Project scope guidance (#1226, #1227, ADR-0098): one hidden custom message
 * every native session carries. It tells a project session to make
 * repository changes only inside its own checkout (a chat: in no repository),
 * where other repositories' work goes instead (a dispatched session, the
 * dispatching session, or the user), and how to treat files outside every
 * repository. The main process arms it at protocol readiness from the same
 * fleet tool access value that registers the fleet tools.
 *
 * Unlike the Ask pin, the text changes when the checkout or role changes
 * (worktree convert/release, fork, migration, setting flip), so the bridge
 * dedupes on content: it sends only when the latest project scope message on
 * the branch is absent or differs. Every text opens by saying it replaces any
 * earlier one. Guidance, not enforcement.
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
 * - `no-dispatch`: a session without the fleet tools (setting off, or started by an external sender).
 */
export type ProjectScopeRole = "dispatch" | "report-to-parent" | "report-to-user" | "no-dispatch";

/** Absolute paths named in the outside-files paragraph. */
export interface ProjectScopeFences {
  /** getOmpAgentDir() */
  agentDir: string;
  /** path.dirname(registryFile) */
  userData: string;
  sessionsRoot: string;
  archiveRoot: string;
}

export interface ProjectScopeInput {
  kind: "project" | "chat";
  /** Ignored for a chat. */
  projectName: string;
  projectCwd: string;
  /** record.worktree?.path ?? record.projectCwd */
  checkoutPath: string;
  role: ProjectScopeRole;
  fences: ProjectScopeFences;
}

const LOCATION_FALLBACK =
  "This session belongs to one omp-ui project; its working directory is that project's checkout.";

const ROLE_TEXT: Record<ProjectScopeRole, string> = {
  dispatch: [
    "When the work also needs changes in another repository, do not edit that repository from this session. Dispatch the change instead: call omp-ui_fleet_machines to find the other project's absolute path on this computer (or its repository key), then call omp-ui_fleet_dispatch once per repository with that project, a short title, and a self-contained prompt that states exactly what to change there and why. The dispatched session cannot see this conversation. Leave machines out unless the user names a machine.",
    "Read each dispatch result. When it reports a started session, finish your own part and end your turn: omp-ui posts a Fleet result into this session when that session finishes its first run, so do not poll. When it reports a failure, tell the user the dispatch failed and what the other repository still needs. When the outcome is unknown, tell the user and do not dispatch the same work again.",
    "While this session is in Plan mode, do not dispatch implementation work and do not add projects: describe the other repository's change in your plan instead. Dispatch only when the user asks for planning in another repository, and then pass planMode true with a prompt that asks for a plan.",
    'If the other repository is not a registered omp-ui project, ask omp-ui to add it with omp-ui_fleet_project and machine "this computer": verb register with the checkout\'s absolute path when it is already on disk, or verb clone with its https or SSH URL when it is not. Never clone it with your own shell: omp-ui asks the user to approve every request and, for a clone, where to save it. omp-ui_fleet_machines lists only projects with a ready model provider, so register also tells you when a path is already registered. When a request is accepted, dispatch to the path it returns. When it is refused, tell the user what that repository needs and do not add it another way.',
    "If omp-ui_fleet_dispatch or omp-ui_fleet_project is not available in this session, tell the user what needs to change in the other repository and do not edit it from this session.",
  ].join("\n\n"),
  "report-to-parent":
    "Another session dispatched this one to change this project only. If the work also needs changes in another repository, do not edit that repository and do not try to dispatch it. Finish the work in this project, then begin your final reply with the other repository's name and the exact change it needs, in a few lines, before anything else: omp-ui forwards only the first 2,000 characters of that reply to the session that dispatched you, and only after your first run. If you find the need in a later turn, tell the user instead.",
  "report-to-user":
    "This is a private session, so do not dispatch work to other sessions, do not add projects, and do not edit other repositories. When the work also needs changes in another repository, finish your own part and tell the user what the other repository needs.",
  "no-dispatch":
    "This session cannot dispatch work to other sessions. When the work also needs changes in another repository, do not edit that repository: finish your own part and tell the user what the other repository needs.",
};

function opening(location: string): string {
  return `omp-ui project scope. This replaces any earlier omp-ui project scope message. ${location} Make repository changes only inside that checkout. Reading other repositories for context is fine, and this rule does not limit session artifacts (local://) or the omp-ui vault tools, which follow their own rules.`;
}

const CHAT_OPENING =
  "omp-ui project scope. This replaces any earlier omp-ui project scope message. This session is a chat: it belongs to no project, and its working directory is a scratch folder. Do not edit any repository from this chat. Reading repositories for context is fine, and this rule does not limit session artifacts (local://) or the omp-ui vault tools, which follow their own rules.";

interface FenceNames {
  agent: string;
  data: string;
  sessions: string;
}

function namedFences(f: ProjectScopeFences): FenceNames {
  return {
    agent: `omp's agent folder ${f.agentDir}`,
    data: `omp-ui's data folder ${f.userData}`,
    sessions: `omp's session folders ${f.sessionsRoot} and ${f.archiveRoot}`,
  };
}

const GENERIC_FENCES: FenceNames = {
  agent: "omp's agent folder (~/.omp/agent unless PI_CODING_AGENT_DIR moves it)",
  data: "omp-ui's data folder",
  sessions: "omp's session and archive folders",
};

/**
 * Files outside every repository. A dispatched child (`child`) cannot ask its
 * user, so it changes only what its dispatch prompt names and reports the rest.
 */
function outsideFiles(names: FenceNames, child: boolean): string {
  return [
    "Files outside your checkout that belong to no repository or project: judge a path by where it resolves after symlinks, so a dotfile linked into a git repository counts as that repository, and a folder omp-ui lists as a project counts as a project even without git.",
    child
      ? "Change other files, such as shell startup files, ~/.config, or /etc, only when the prompt that dispatched you names them; otherwise report the need instead."
      : "Change other files, such as shell startup files, ~/.config, or /etc, only when the user's request names them or clearly needs them; otherwise ask first.",
    child
      ? `Do not change ${names.agent} (extensions, hooks, tools, mcp.json, config, skills): it runs in every session, so report the need instead.`
      : `Ask before changing anything in ${names.agent} (extensions, hooks, tools, mcp.json, config, skills): it runs in every session.`,
    `Never edit ${names.data}, ${names.sessions}, or omp's auth and history databases, apart from this session's own checkout and artifacts; vault notes go through the omp-ui vault tools.`,
    "Change root-owned files only with sudo -n, and when it fails give the user the command instead.",
    child
      ? "Near the start of your final reply, list every such change and every reported need by path and what changed, without secret values."
      : "In your final reply, list every such change by path and what changed, without secret values.",
    "In Plan mode, put these changes in the plan instead of making them.",
  ].join(" ");
}

/**
 * Model-facing guidance. Never exceeds PROJECT_SCOPE_TEXT_MAX (the bridge
 * drops an over-cap arm silently). Three tiers, first that fits wins:
 * full location + named fences, LOCATION_FALLBACK + named fences,
 * LOCATION_FALLBACK + generic fences. Role paragraphs are always intact.
 */
export function projectScopeGuidance(input: ProjectScopeInput): string {
  const role = ROLE_TEXT[input.role];
  const child = input.role === "report-to-parent";
  const compose = (head: string, names: FenceNames): string =>
    `${head}\n\n${role}\n\n${outsideFiles(names, child)}`;
  const named = namedFences(input.fences);
  let fullHead: string;
  let fallbackHead: string;
  if (input.kind === "chat") {
    fullHead = fallbackHead = CHAT_OPENING;
  } else {
    const checkout = input.checkoutPath === input.projectCwd ? "" : `, working in the checkout ${input.checkoutPath}`;
    fullHead = opening(`This session belongs to the project "${input.projectName}" at ${input.projectCwd}${checkout}.`);
    fallbackHead = opening(LOCATION_FALLBACK);
  }
  for (const candidate of [compose(fullHead, named), compose(fallbackHead, named)]) {
    if (candidate.length <= PROJECT_SCOPE_TEXT_MAX) return candidate;
  }
  return compose(fallbackHead, GENERIC_FENCES);
}
