# Phase 3: ACP Integration

> Verified against `@oh-my-pi/pi-coding-agent` **v17.1.8**
> (`src/modes/acp/acp-mode.ts`, `acp-agent.ts`) and the installed
> `@agentclientprotocol/sdk`. Zed configuration verified against
> [zed.dev/docs/ai/external-agents](https://zed.dev/docs/ai/external-agents).

## Goal

Document and optionally build a thin wrapper that makes OMP available through the
**Agent Client Protocol** (ACP) — the JSON-RPC protocol Zed uses for external
agents ([agentclientprotocol.com](https://agentclientprotocol.com)). This lets
existing ACP clients (Zed and others) drive OMP with zero additional code from
omp-ui.

## ACP Mode Exists Today

OMP ships an ACP server (`src/modes/acp/`, `omp acp`):

```bash
# Run OMP as an ACP server over stdio
omp acp
```

The server speaks newline-delimited JSON-RPC over stdin/stdout using
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
(`AgentSideConnection` + `ndJsonStream`). Running it by hand prints a notice on
stderr — stdout is the transport, so nothing may be printed there.

### Real protocol surface

The agent side (`acp-agent.ts`) implements:

| Method | Purpose |
|---|---|
| `initialize` | Handshake + capability negotiation |
| `authenticate` | Provider auth flow |
| `session/new` | Create a session (OMP session) for a cwd |
| `session/load` | Load an existing session by id |
| `session/resume` | Resume an existing session |
| `session/fork` | Fork a session (unstable) |
| `session/list` | List sessions |
| `session/close` | Close a session |
| `session/set_mode` | Switch session mode (plan etc.) |
| `session/set_config_option` | Set model / thinking level (`model`, `thinking` config ids) |
| `session/prompt` | Send a user message |
| `session/cancel` | Cancel the in-flight prompt |

Plus `session/update` notifications (streaming `SessionUpdate`s to the client)
and the client-capability methods OMP may call back: `fs/read_text_file`,
`fs/write_text_file`, `terminal/*`, `session/request_permission`.

Earlier drafts of this doc listed `threads/create`, `blocks/create`,
`executions/create` — those methods do not exist in ACP.

**Interop hazard, verified in source** (`acp-agent.ts:103`): OMP deliberately
waits `ACP_BOOTSTRAP_RACE_GUARD_MS` (50 ms) after `session/new` (or
`load`/`resume`/`fork`) returns before firing the first notifications against
the new session id — this mitigates Zed's `Received session notification for
unknown session` race. Any custom ACP client must tolerate the same ordering.

## Zed Configuration

**Primary path: the ACP Registry.** Pi Coding Agent is a listed External Agent
in Zed — open the registry with `zed: acp registry` (or Agent Settings →
External Agents → Add Agent → Install from Registry). No manual config needed.

**Custom agent path** (for development against a local OMP build), current
`agent_servers` shape:

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "oh-my-pi": {
      "type": "custom",
      "command": "omp",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Debug with `dev: open acp logs` in Zed's command palette to inspect the
JSON-RPC traffic.

## What ACP Provides

| Feature | ACP | Phase 1 (PTY) | Phase 2 (RPC-UI) |
|---|---|---|---|
| Project switching | `cwd` in `session/new` | Via `--cwd` flag | Via `new_session` command |
| Session resume | `session/load` / `session/resume` | Via `--resume` | Via `switch_session` |
| Tool execution | Client forwards permission (`session/request_permission`) | Through TUI | Via `bash` command |
| Advisor notes | Arrive as `session/update` message content | Full (native to OMP TUI) | Full (structured `details.notes`) |
| Diff rendering | Client's responsibility | Through TUI | Via tool-result `details.diff` |
| Native UI | Client's responsibility | None (terminal) | Custom implementation |

## omp-ui as an ACP Client

If a lightweight ACP GUI shell emerges (several open-source projects are
attempting this), omp-ui's project sidebar concept could be implemented as an
ACP client wrapper:

```ts
// Spawn omp as an ACP server
const child = spawn("omp", ["acp"], { cwd: projectPath });

// Create a session in the project
await sendJson(child.stdin, {
  jsonrpc: "2.0",
  id: 1,
  method: "session/new",
  params: { cwd: projectPath, mcpServers: [] },
});
// → { sessionId: "…" } — remember the 50 ms bootstrap race guard above

// Send a user message
await sendJson(child.stdin, {
  jsonrpc: "2.0",
  id: 2,
  method: "session/prompt",
  params: {
    sessionId,
    prompt: [{ type: "text", text: "Refactor the auth module" }],
  },
});
```

The advantage: zero OMP-specific code. You just speak ACP.

**Owned-session rules still apply** (ADR-0003): if omp-ui spawns `omp acp`
itself, pin a fresh lineage dir (`--session-dir`) and record the session in
the registry, exactly as in Phases 1–2. When Zed (or another external client)
owns the spawn, omp-ui tracks nothing — those sessions are not owned.

## When to Use ACP vs Phases 1/2

| If you want... | Use |
|---|---|
| OMP TUI in a window with project switching | Phase 1 (PTY embed) |
| Native advisor panel, diffs, todos | Phase 2 (RPC-UI) |
| Integrate with Zed or another ACP client | ACP mode (`omp acp`, registry install) |
| Wait for a community ACP GUI that you can wrap | Phase 3 (ACP client) |

## Conclusion

OMP's ACP mode means the "does something like this already exist" answer is
**partially yes** — Zed lists Pi Coding Agent in its ACP Registry today. Your
project sidebar vision is best served by Phase 1 (PTY embed) now, with Phase 2
as an optional upgrade and ACP integration as a complementary path.

## Rough Timeline

| Task | Time |
|---|---|
| Document ACP config for Zed (registry + custom) | 1 day |
| Test existing ACP clients with OMP | 1 day |
| Optional: thin ACP client wrapper (if needed) | 1–2 days |
| **Total** | **~2 days (documentation only)** |
