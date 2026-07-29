# Phase 3: ACP Integration

## Goal

Document and optionally build a thin wrapper that makes OMP available through the
**Agent Client Protocol** (ACP) — the Zed-standard JSON-RPC protocol. This lets
existing ACP clients (Zed, Cursor, other GUI shells) drive OMP with zero
additional code from omp-ui.

## ACP Mode Exists Today

OMP ships an ACP server at `src/modes/acp/` (`commands/acp.ts`):

```bash
# Run OMP as an ACP server over stdio
omp acp
```

The server speaks JSON-RPC over stdin/stdout using
[`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk).
It accepts the standard ACP `initialize`, `threads/create`, `blocks/create`,
`blocks/append`, `executions/create`, `executions/cancel` messages.

**Clients that work today:**
- Zed (configure `agent_servers` in `~/.config/zed/settings.json`)
- Cursor (ACP support in Cursor settings)
- Any ACP-compliant client

## Zed Configuration Example

```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "oh-my-pi": {
      "command": {
        "path": "omp",
        "args": ["acp"],
        "cwd": "{buffer_directory}"
      }
    }
  }
}
```

## What ACP Provides

| Feature | ACP | Phase 1 (PTY) | Phase 2 (RPC-UI) |
|---|---|---|---|
| Project switching | Via `cwd` in `threads/create` | Via `--cwd` flag | Via `new_session` command |
| Session resume | Via `threads/create` with existing | Via `--resume` | Via `switch_session` |
| Tool execution | Via `tools/invoke` | Through TUI | Via `bash` command |
| Advisor notes | Not yet standardized in ACP | Full (native to OMP TUI) | Full (via extension_ui_request) |
| Diff rendering | Client's responsibility | Through TUI | Via RPC diff frames |
| Native UI | Client's responsibility | None (terminal) | Custom implementation |

## omp-ui as an ACP Client

If a lightweight ACP GUI shell emerges (several open-source projects are
attempting this), omp-ui's project sidebar concept could be implemented as an
ACP client wrapper:

```ts
// Spawn omp as an ACP server
const { stdin, stdout } = spawn("omp", ["acp"], { cwd: projectPath });

// Create a thread (session) in the project
await sendJson(stdin, {
  jsonrpc: "2.0",
  id: 1,
  method: "threads/create",
  params: {
    // ACP thread = OMP session
  }
});

// Send a user message
await sendJson(stdin, {
  jsonrpc: "2.0",
  id: 2,
  method: "blocks/create",
  params: {
    thread_id: threadId,
    contents: [{ type: "text", text: "Refactor the auth module" }]
  }
});
```

The advantage: zero OMP-specific code. You just speak ACP.

## When to Use ACP vs Phases 1/2

| If you want... | Use |
|---|---|
| OMP TUI in a window with project switching | Phase 1 (PTY embed) |
| Native advisor panel, diffs, todos | Phase 2 (RPC-UI) |
| Integrate with Zed/Cursor or another ACP client | ACP mode (`omp acp`) |
| Wait for a community ACP GUI that you can wrap | Phase 3 (ACP client) |

## Conclusion

OMP's ACP mode means the "does something like this already exist" answer is
**partially yes** — existing ACP clients can drive OMP today. Your project
sidebar vision is best served by Phase 1 (PTY embed) now, with Phase 2 as an
optional upgrade and ACP integration as a complementary path.

## Rough Timeline

| Task | Time |
|---|---|
| Document ACP config for Zed/Cursor | 1 day |
| Test existing ACP clients with OMP | 1 day |
| Optional: thin ACP client wrapper (if needed) | 1–2 days |
| **Total** | **~2 days (documentation only)** |
