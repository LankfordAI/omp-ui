/**
 * Remote instances (issue #416): the pure half. Validation, URL normalization,
 * and the channel allowlists the main-process proxy enforces. Zero `node:`
 * imports — the renderer imports this module for the settings form; the
 * credential store lives in remote-instance-store.ts.
 */

export const REMOTE_INSTANCE_NICKNAME_MAX = 32;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

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
  "session:terminate",
  "session:hibernatePlanSource",
  "session:switchMode",
  "session:deletePreview",
  "session:delete",
  "session:fork",
  "session:setAdvisor",
  "session:setModel",
  "session:move",
  "plan:read",
  "plan:answer",
  "session:restart",
  "session:convert-to-worktree",
  "worktree:sync",
  "worktree:renameBranch",
  "session:release-worktree",
  "session:capabilities",
  "session:tool-enabled",
  "pty:pasteImage",
  "shell:spawn",
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
]);

/** Project-scoped channels the renderer may address to a joined instance through the proxy. */
const PROJECT_PROXY_CHANNELS: readonly string[] = [
  "state:get",
  "project:add",
  "project:remove",
  "project:move",
  "project:setDefaultModel",
  "project:setDefaultAdvisorModel",
  "dir:browse",
  "session:spawn",
  "advisor:defaults",
  "title:generate",
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
  "project-files:list",
  "file-mentions:resolve",
];

/**
 * Every channel the main-process proxy forwards to a joined instance. Anything
 * else — settings, window, host-local opens, updates, remote access, providers,
 * diagnostics, the instance's own remote-instance channels — is refused.
 */
export const REMOTE_PROXY_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...TAB_ROUTED_REQUESTS,
  ...TAB_ROUTED_NOTIFIES,
  ...PROJECT_PROXY_CHANNELS,
]);

/** Events a joined instance emits that are mirrored to local sinks unchanged. */
export const REMOTE_TAB_EVENTS: ReadonlySet<string> = new Set<string>([
  "pty:data",
  "pty:exit",
  "rpc:frame",
  "session:hibernated",
  "shell:data",
  "shell:exit",
]);
