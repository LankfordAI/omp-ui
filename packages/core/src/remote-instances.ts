/**
 * Remote instances (issue #416): the pure half. Validation, URL normalization,
 * and the channel allowlists the main-process proxy enforces. Zero `node:`
 * imports — the renderer imports this module for the settings form; the
 * credential store lives in remote-instance-store.ts.
 */

import { CONTROL_CHARS } from "./fleet";

export const REMOTE_INSTANCE_NICKNAME_MAX = 32;

/** Trims, enforces 1–32 code points and no control characters. Rejects with a user-facing message. */
export function validateNickname(raw: string): string {
  const nickname = raw.trim();
  if (nickname === "") throw new Error("nickname is empty");
  if (CONTROL_CHARS.test(nickname)) throw new Error("nickname must not contain control characters");
  if ([...nickname].length > REMOTE_INSTANCE_NICKNAME_MAX) {
    throw new Error(`nickname must be at most ${REMOTE_INSTANCE_NICKNAME_MAX} characters`);
  }
  return nickname;
}

/** `new URL(url).host` — hostname plus explicit port. */
export function defaultNickname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Accepts `http(s)://host[:port][/][?t=token]`. Returns the origin and the
 * token found in `?t=`, if any. Rejects other schemes, credentials in the
 * authority, and unparsable input with a user-facing message.
 */
export function normalizeInstanceUrl(raw: string): { origin: string; token: string | null } {
  const text = raw.trim();
  if (text === "") throw new Error("connection URL is empty");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("connection URL must look like http://host:port");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("connection URL must start with http:// or https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("connection URL must not carry a username or password");
  }
  if (url.hostname === "") throw new Error("connection URL must name a host");
  const token = url.searchParams.get("t");
  return { origin: url.origin, token: token === null || token === "" ? null : token };
}

/** Case-insensitive uniqueness among the given nicknames (excluding `exceptId`). */
export function assertNicknameUnique(
  nickname: string,
  existing: ReadonlyArray<{ id: string; nickname: string }>,
  exceptId: string | null,
): void {
  const wanted = nickname.toLowerCase();
  for (const entry of existing) {
    if (entry.id === exceptId) continue;
    if (entry.nickname.toLowerCase() === wanted) {
      throw new Error(`an instance named "${entry.nickname}" already exists`);
    }
  }
}

export interface RemoteInstanceRecord {
  id: string;
  nickname: string;
  url: string;
  addedAt: string;
}

/** Request channels whose first argument is the owning tabId; main routes them to that tab's instance. */
export const TAB_ROUTED_REQUESTS: ReadonlySet<string> = new Set<string>([
  "session:hibernatePlanSource",
  "session:settle",
  "session:switchMode",
  "session:deletePreview",
  "session:delete",
  "session:fork",
  "session:transcriptPath",
  // A session reference names the owner's machine and its path there (#984).
  "session:reference",
  "session:setAdvisor",
  "session:setApprovalMode",
  "session:setModel",
  "session:setSubagentModels",
  "session:setSnoozed",
  "session:setPinned",
  // Pull request links live on the session's host (issue #985).
  "session:setAutoSettleOnMerge",
  "session:refreshPullRequests",
  // A held prompt waits on the session's host (issue #986).
  "session:holdPrompt",
  "session:cancelHeldPrompt",
  "session:sendHeldPromptNow",
  // A scheduled prompt fires on the session's host (issue #987).
  "session:setScheduledPrompt",
  "session:clearScheduledPrompt",
  "session:runScheduledPromptNow",
  "plan:read",
  "plan:answer",
  "plan:dismiss",
  "session:restart",
  "session:convert-to-worktree",
  "worktree:sync",
  "worktree:discarded",
  "worktree:applyDiscarded",
  "worktree:renameBranch",
  "session:release-worktree",
  "session:capabilities",
  "session:modelCatalog",
  "session:tool-enabled",
  "pty:pasteImage",
  // Document Attachments materialize on the owning instance's machine (ADR-0044),
  // and so do a native prompt's image copies (issue #993).
  "session:attachDocument",
  "session:attachImage",
  // A stashed draft re-captures a path-only document's bytes on its host (#989).
  "session:readDocument",
  "pty:pasteDocument",
  "shell:spawn",
  "browser-pane:ensure",
  "browser-pane:pick",
  "device-pane:ensure",
  "device-pane:act",
  // Collab commands carry the owning tab (#686): a remote control-plane tab
  // drives the owner's tracker, which writes into the owner's PTY child.
  "collab:share",
  "collab:stop",
  "collab:link",
  // A dispatched session's summary is rendered by its owner (issue #899);
  // the fleet status tool reads it through the join.
  "fleet:sessionSummary",
  // A joined remote-instance tab now carries its own live call (#968): its
  // spoken turns and recordings belong to the owner's lineage dir.
  "liveTranscript:append",
  "liveTranscript:read",
  "liveAudio:list",
  "liveAudio:read",
]);

/** Notify channels whose first argument is the owning tabId. */
export const TAB_ROUTED_NOTIFIES: ReadonlySet<string> = new Set<string>([
  "pty:write",
  "pty:resize",
  "shell:kill",
  "shell:write",
  "shell:resize",
  "rpc:send",
  "stall:cap",
  "browser-pane:subscribe",
  "browser-pane:resize",
  "browser-pane:input",
  "browser-pane:navigate",
  "browser-pane:set-open",
  "device-pane:subscribe",
  "device-pane:input",
  "device-pane:set-open",
]);

/** Project-scoped channels the renderer may address to a joined instance through the proxy. */
const PROJECT_PROXY_CHANNELS: readonly string[] = [
  "state:get",
  "project:add",
  "project:remove",
  "project:setDefaultModel",
  "project:setDefaultAdvisorModel",
  "project:setBrowserClock",
  "project:setKnowledgeHome",
  "project:setIcon",
  "project:getSubagentModels",
  "project:setSubagentModel",
  "dir:browse",
  "session:spawn",
  "advisor:defaults",
  "title:generate",
  "title:retitle",
  "branch:nameSuggest",
  "branch:diff",
  "branch:list",
  "branch:checkout",
  "branch:pull",
  // A remote-instance session pushes and links its own host's branches (#414,
  // routed by instanceId the same way pull already is, issue #416).
  "branch:push",
  "branch:prUrl",
  "branch:mergeDestination",
  "branch:mergeStatus",
  "branch:mergeBack",
  "branch:create",
  "mcp:list",
  "mcp:setEnabled",
  "capabilities:scoped",
  "capabilities:scoped:set",
  "watchdog:roster",
  "watchdog:roster:set",
  "project-files:list",
  "file-mentions:resolve",
  // The Lab reads a joined instance's experiments from that instance's own
  // autoresearch DBs (issue #559); the DB and run logs live on the owning host.
  "autoresearch:overview",
  "autoresearch:experiment",
  "autoresearch:runLog",
];

/**
 * Every channel the main-process proxy forwards to a joined instance. Anything
 * else — settings, window, host-local opens, updates, remote access, providers,
 * diagnostics, the instance's own remote-instance channels — is refused.
 *
 * The #888 bundle-transfer channels are proxied by design: session pack/
 * ingest chunks and the two auth bundle verbs run on whichever host owns the
 * files, addressed with `backendFor(instanceId)`. Auth orchestration
 * (`auth:carry-*`, save/pick/import-file) and `session:mark-moved` stay off
 * this list — they run only in the acting app's main. None of these is
 * tab-scoped or project-scoped, so they join the union directly.
 */
export const REMOTE_PROXY_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...TAB_ROUTED_REQUESTS,
  ...TAB_ROUTED_NOTIFIES,
  ...PROJECT_PROXY_CHANNELS,
  // The remote's favorite model list follows the owning instance (issue #440):
  // a remote palette toggles the remote's own favorites, never host state.
  // Instance-scoped rather than project-scoped, so it rides here directly.
  "favorites:toggle",
  // The Knowledge tab of a joined project lists that host's vault names (#759); names only, no path, and no other vault:* channel crosses.
  "vault:names",
  // Cross-session stats follow the owning instance (#668): the stats DB is
  // that host's own ~/.omp/stats.db, read by that instance's core.
  "stats:overview",
  // Fleet placement reads each member's resources and projects (issue #899).
  // fleet:dispatch / fleet:machines orchestrate in the acting app's main and
  // never reach a joined instance.
  "fleet:hostReport",
  // Fleet exec ladder (issue #901, ADR-0062): the bounded command channel, the
  // rung-3 project verbs, the rung probe, and the raise ceremony are proxied —
  // every enforcement decision lands in the OWNER's handler, never here. The
  // local orchestration (fleet:machines / fleet:dispatch / fleet:grantSet /
  // fleet:audit, the settings channels) stays off this list. Detached exec and
  // Provider key rollout (issue #905, ADR-0065) join it the same way: the
  // owner checks Full control; key values cross main-to-main only, and the
  // local fleet:rolloutProviderKeys orchestration stays off this list. Fleet
  // remote version update follows the same split: fleet:updateMember and
  // fleet:updatePoll are proxied; the local fleet:updateMachine is not. Fleet
  // send (#959) and fleet finish (#978) are proxied too; the owner re-checks
  // the dispatcher and rung. Project copy's file write (#992) is proxied and
  // main-to-main; its local fleet:copyProject / fleet:projectCopyPreview
  // orchestration stays off this list. Fleet terminal (#991, ADR-0084): the
  // member legs — open, renew, end, write, size — are proxied and the owner
  // checks the Terminal rung; the local fleet:terminalStart / Close / Input /
  // Resize stay off this list.
  "fleet:exec",
  "fleet:projectManage",
  "fleet:projectFiles",
  "fleet:grantRung",
  "fleet:grantRaise",
  "fleet:execDetach",
  "fleet:execPoll",
  "fleet:providerKeys",
  "fleet:updateMember",
  "fleet:updatePoll",
  "fleet:send",
  "fleet:finish",
  "fleet:terminalOpen",
  "fleet:terminalRenew",
  "fleet:terminalEnd",
  "fleet:terminalWrite",
  "fleet:terminalSize",
  // Session migration (#888): the pack legs run on the source host, the
  // ingest legs on the target; every chunk frame is base64 under the socket's
  // MAX_PAYLOAD. Transcript bytes may ride the renderer (already visible
  // there); credential bundles transit main-to-main only.
  "session:pack-start",
  "session:pack-chunk",
  "session:pack-abort",
  "session:ingest-start",
  "session:ingest-push",
  "session:ingest-finish",
  "auth:export-bundle",
  "auth:import-bundle",
]);

/** Events a joined instance emits that are mirrored to local sinks unchanged. */
export const REMOTE_TAB_EVENTS: ReadonlySet<string> = new Set<string>([
  "pty:data",
  "pty:exit",
  "rpc:frame",
  "session:hibernated",
  "session:autoSettled",
  "shell:data",
  "shell:exit",
  "browser-pane:frame",
  "browser-pane:state",
  "device-pane:frame",
  "device-pane:state",
  "collab:changed",
]);
