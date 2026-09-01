# Phase 2: RPC-UI Native Rendering

[Documentation home](README.md)

**Current status:** Native RPC UI sessions are shipped and are the default
session mode. See the [current architecture](architecture.md) and
[user guide](user-guide.md) for the implemented behavior. The original design
record follows.

## Goal

Replace the xterm.js terminal in the main pane with native UI components by using
OMP's `--mode=rpc-ui` headless JSON protocol. The project sidebar stays the same.
The main pane renders transcripts, diffs, todos, and advisor notes as native React
components instead of terminal text.

## The Protocol

OMP's `src/modes/rpc/rpc-mode.ts` implements a bidirectional JSON protocol over
stdin/stdout (verified against `@oh-my-pi/pi-coding-agent` v17.1.8,
`src/modes/rpc/rpc-types.ts`, `rpc-frame.ts`, `rpc-mode.ts`):

```
┌─────────────┐        JSON stdin        ┌────────┐
│  omp-ui GUI │  ─────────────────────►   │  omp   │
│  (frontend) │  ◄──────────────────────   │  CLI   │
│            │        JSON stdout        │        │
└─────────────┘                           └────────┘
                        --mode=rpc-ui
```

### Framing and handshake (do this first)

Frames are newline-delimited JSON with a **1 MiB per-frame cap**
(`MAX_RPC_FRAME_BYTES`). On connect, OMP emits a `ready` frame:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
```

Reply with `{"type":"negotiate_protocol","protocolVersion":2}` to move to
protocol v2. **v2 fragments any frame over 1 MiB into `rpc_chunk` frames:**

```json
{"type":"rpc_chunk","chunkId":"…","index":0,"count":3,"byteLength":…,"data":"<base64>"}
```

Chunks must be reassembled strictly in order (`index` starts at 0, `chunkId` /
`count` / `byteLength` must match across chunks — the reader throws otherwise),
up to a 64 MiB reassembly cap (`MAX_RPC_REASSEMBLED_BYTES`; past it OMP sends an
overflow frame instead). **A naive one-JSON-per-line client silently breaks on
exactly the payloads a GUI cares about** — large diffs, big file reads,
`get_messages` on long sessions. Implement the handshake and reassembly before
anything else; it is Phase 2's day-1 work.

### Commands to OMP (stdin)

`rpc-types.ts` defines 41 command types (`RpcCommand` union), grouped:

| Group | Commands |
|---|---|
| Protocol | `negotiate_protocol` |
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session` |
| State | `get_state`, `get_available_commands`, `set_todos`, `set_host_tools`, `set_host_uri_schemes`, `set_subagent_subscription`, `get_subagents`, `get_subagent_messages` |
| Model | `set_model`, `cycle_model`, `get_available_models` |
| Thinking | `set_thinking_level`, `cycle_thinking_level` |
| Queue modes | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` |
| Compaction | `compact`, `set_auto_compaction` |
| Retry | `set_auto_retry`, `abort_retry` |
| Bash | `bash`, `abort_bash` |
| Session | `get_session_stats`, `export_html`, `switch_session`, `branch`, `get_branch_messages`, `get_last_assistant_text`, `set_session_name`, `handoff` |
| Messages | `get_messages`, `get_messages_page` |
| Login | `get_login_providers`, `login` |

Every command takes an optional `id` for correlation; replies arrive as
`{"type":"response","command":"<name>","success":true|false, …}` with the
same `id`.

### Events from OMP (stdout)

Two distinct kinds of traffic share stdout:

**1. RPC control frames** (the `rpc-types.ts` inventory):

| Frame | Purpose |
|---|---|
| `ready` | Handshake advertisement (see above) |
| `response` | Command reply (success or `{success:false, error, code?}`) |
| `rpc_chunk` | Protocol-v2 frame fragmentation (see handshake) |
| `prompt_result` | A prompt finished (`agentInvoked`) |
| `available_commands_update` | Slash-command inventory changed |
| `command_output` | Text output from a slash command |
| `session_info_update` | Title / session id changed |
| `config_update` | Model / thinking level changed |
| `extension_ui_request` | Extension needs UI (see below) |
| `extension_error` | An extension threw |
| `subagent_lifecycle` / `subagent_progress` / `subagent_event` | Subagent tracking |
| `host_tool_call` / `host_tool_cancel` / `host_tool_update` / `host_tool_result` | OMP invoking a GUI-registered host tool |
| `host_uri_request` / `host_uri_cancel` / `host_uri_result` | OMP resolving a GUI-registered URI scheme |

**2. The streaming content itself — raw `AgentSessionEvent` objects** emitted
onto stdout as they occur (`rpc-mode.ts:10`: "Events: AgentSessionEvent objects
streamed as they occur"). This is the union from
`src/session/agent-session-events.ts` — **the actual rendering surface for the
transcript**. There is no `chunk` frame; earlier drafts of this doc invented
one.

The union, verified against v17.1.8:

- Core `AgentEvent` (`@oh-my-pi/pi-agent-core/src/types.ts:841`): `agent_start`,
  `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`,
  `message_end`, `tool_execution_start`, `tool_execution_update`,
  `tool_execution_end`. There is no standalone "thinking" event — streaming
  thinking/text arrives inside `message_update.assistantMessageEvent`.
- Session extensions (`agent-session-events.ts:12`): `auto_compaction_start` /
  `_end`, `auto_retry_start` / `_end`, `retry_fallback_applied` / `_succeeded`,
  `ttsr_triggered`, `todo_reminder`, `todo_auto_clear`, `irc_message`,
  `notice`, `thinking_level_changed`, `goal_updated`, plus an `agent_end`
  override adding `isTerminal?`.

This is the single biggest driver of Phase 2's cost: a native renderer must
exhaustively handle the `AgentSessionEvent` union, not just the 41 commands.

### Extension UI Protocol

Extensions can request UI interactions. Methods (`RpcExtensionUIRequest`):
`select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`,
`setTitle`, `set_editor_text`, `open_url`, `cancel`.

```ts
// OMP emits:
{ type: "extension_ui_request", id: "abc", method: "confirm", title: "...", message: "..." }
{ type: "extension_ui_request", id: "def", method: "select", title: "...", options: ["a", "b"] }
{ type: "extension_ui_request", id: "ghi", method: "input", title: "...", label: "..." }

// GUI responds:
{ type: "extension_ui_response", id: "abc", confirmed: true }
{ type: "extension_ui_response", id: "def", value: "a" }
{ type: "extension_ui_response", id: "ghi", cancelled: true }
```

## Native Components

### Transcript Renderer

Instead of terminal text, render each message type natively:

```tsx
// Advisor notes render as colored cards:
<AdvisoryCard severity="blocker" advisor="security">
  Hardcoded API key detected in src/config.ts:42
</AdvisoryCard>

// Thinking blocks as expandable sections:
<ThinkingBlock model="gemma-4-31b-it" expanded={false}>
  Analyzing the auth module...
</ThinkingBlock>

// Tool calls as interactive cards:
<ToolCallCard toolName="bash" status="completed" result={...}>
  cd src && npm test
</ToolCallCard>
```

OMP's `AgentSessionEvent` stream provides:
- Message lifecycle (`message_start` / `message_update` / `message_end`)
- Thinking + text streaming inside `message_update.assistantMessageEvent`
- Tool executions (`tool_execution_start` / `_update` / `_end`) with args and results
- **Advisor cards** (see below)

#### Advisor cards

Advisor notes arrive as ordinary messages in the stream: a `CustomMessage` with
`role: "custom"` and `customType: "advisor"` (`isAdvisorCard`,
`session/queued-messages.ts:33`). The message `content` is the agent-facing
`<advisory advisor="…" severity="…">` XML, but the **structured data is in
`details.notes`** — `AdvisorMessageDetails = { notes: AdvisorNote[] }` with
`{ note, severity, advisor }` per note (`session/session-advisors.ts:855`).
Render cards from `details.notes`; never regex the XML.

Severity drives delivery (`isInterruptingSeverity`, `advisor/advise-tool.ts`):
`concern` / `blocker` interrupt the running agent via the steering channel;
`nit` queues to the next step boundary. The UI should mirror that hierarchy —
interrupting severities as attention-demanding cards, nits as quiet badges.

### Diff Viewer

There is no `diffResult` frame. Edit/write tool results carry a diff string in
their `details.diff` field, delivered inside `tool_execution_end.result`.

**It is not a standard unified diff.** `generateDiffString` (`src/edit/diff.ts`)
emits OMP's line-numbered format: rows of `+<lineNum>|<content>`,
`-<lineNum>|<content>`, ` <lineNum>|<content>`, `@@ ` context markers, and an
`*** End of File` marker — no `@@ -a,b +c,d @@` hunk headers. (True unified
output exists but is only used by `modes/patch.ts`.) Parse the numbered format
— rows match `/^([+\- ])(\d+)\|(.*)$/` — or the first render is garbage:

```tsx
// result.details.diff is OMP's numbered diff, not unified
<DiffViewer path="src/auth.ts" ompDiff={toolResult.details.diff} />
```

### Todo List

**Verified against v17.1.8 — the phase field is `tasks`, not `items`:**

```jsonc
{ "todoPhases": [ { "phase": "Foundation",
                    "tasks": [ { "content": "…", "status": "pending" } ] } ] }
```

`status` ∈ `pending` | `in_progress` | `completed`. `set_todos` takes the same
`{ phases: [{ phase, tasks }] }` shape and **errors** on an `items` key
(`undefined is not an object (evaluating 'i.tasks.map')`). Reading `items` is
the difference between a working panel and a silently empty one.

### Model Selector

`get_available_models` returned **414 models** on the dev machine, so a
`<select>` is unusable — this needs a searchable palette. Model objects carry
`{ id, name, provider, api, reasoning, input, cost, contextWindow, maxTokens,
thinking: { mode, efforts } }`; `cost` is USD **per million tokens**. Select
with `{ type: "set_model", provider, modelId: model.id }`.

### Other corrections found by probing a live process

The inventory above is otherwise accurate, but these details differ from what
the prose (and in two cases omp's own `.d.ts`) implies:

- `tool_execution_start` carries **`intent`** — a human label ("Reading
  hello.txt"). Replayed history has no `intent`, but the same text survives as
  the tool's own `i` argument.
- `tool_execution_update` carries **`partialResult.content`**: tool output
  streams, so "render on end" leaves bash and subagents looking frozen.
- Assistant `message_end.message` carries `usage`, the requested `model`,
  gateway `provider`, `stopReason`, `duration`, and `ttft`. When OMP supplies
  them, it also carries routed `upstreamProvider` and `responseId`. A large
  `providerPayload` may arrive in the raw RPC but is never retained in a render
  item. `model` is not a routed or selected model: for `openrouter/auto`, the
  OMP event does not reveal the model OpenRouter selected, and omp-ui does not
  infer it.
- `irc_message` nests its payload as a `CustomMessage`: `from`/`text` live under
  `message.details`, **not** top-level.
- omp emits `retry_fallback_succeeded`, not `retry_succeeded`.
- `thinking_level_changed` carries `thinkingLevel`; `cycle_thinking_level`
  replies with `data.level`.
- `set_subagent_subscription` accepts **only** `level: "progress" | "events"`.
- Live queue-mode values are `one-at-a-time` | `all-at-once` (steering,
  follow-up) and `immediate` | `queue` (interrupt) — omp's bundled `.d.ts`
  claims `all`/`immediate`/`wait`, which is wrong. Read the current value
  rather than hardcoding a pair.
- `get_state.data.queuedMessageCount` counts all displayable queued work
  (advisor cards and agent-authored custom entries included), not just
  user-typed messages, and queued follow-ups park after a user interrupt until
  an explicit new prompt. A nonzero count on an idle session is parked work,
  not a stuck refresh (issue #181).
- Slash commands run as `{ type: "prompt", message: "/stats" }`, reply
  `{ data: { agentInvoked: false } }`, and emit their output as separate
  `command_output` frames.
- On boot omp sends `extension_ui_request` with `method: "setWidget"` /
  `"setStatus"`. They still require a reply — omp blocks — but their text is
  worth surfacing rather than discarding.

## Architecture Changes

### Backend: Process Manager (packages/core, plain Node)

Phase 1 needed a PTY because the TUI is a terminal application. Phase 2 does
**not**: `--mode=rpc-ui` speaks newline-delimited JSON over plain stdin/stdout
pipes, so spawn `omp` with `child_process.spawn` and no PTY. Like the Phase 1
PTY manager, this lives in `packages/core` — zero Electron imports:

```
┌──────────────────┐ Electron IPC ┌────────────────────────┐ stdio NDJSON ┌──────────────┐
│ Electron renderer│────────────►│ packages/core          │─────────────►│  omp          │
│ (React)          │◄────────────│ RpcClient (frame codec)│◄─────────────│  --mode=rpc-ui│
└──────────────────┘              └────────────────────────┘              └──────────────┘
```

The core side owns the frame codec — the handshake, the 1 MiB frame cap, and
`rpc_chunk` reassembly from the Protocol section above — and surfaces
reassembled frames as callbacks. The Electron main process is a thin wiring
layer that forwards them over IPC (the same `OmpBackend` boundary as Phase 1,
extended with rpc-ui methods). Because the codec is TypeScript in core, the
future `packages/server` reuses it verbatim:

```ts
// packages/core/src/rpc-client.ts
import { spawn } from "node:child_process";

// Phase 2 sessions are owned sessions too (ADR-0003): the caller mints or
// reuses the lineage dir and records the session in the registry, exactly as
// a Phase 1 PTY spawn — startRpcUi receives that context, not a bare cwd.
export function startRpcUi(
  session: { cwd: string; lineageDir: string },
  onFrame: (frame: unknown) => void,
) {
  const proc = spawn("omp", [
    "--mode=rpc-ui",
    "--cwd", session.cwd,
    "--session-dir", session.lineageDir,
  ]);
  const decoder = new FrameDecoder(); // handshake + rpc_chunk reassembly
  const maxFrameBytes = 1_048_576; // default; use maxFrameBytes from the ready frame

  const abort = () => {
    proc.kill();
    pending = Buffer.alloc(0);
  };

  // Manual line splitting, NOT readline: readline buffers a delimiter-less
  // line unboundedly, so the 1 MiB frame cap could never be enforced — a
  // malformed peer would just grow main-process memory.
  let pending = Buffer.alloc(0);
  proc.stdout.on("data", (chunk: Buffer) => {
    // concat-per-chunk is fine at NDJSON rates; swap in a chunk-list
    // accumulator if profiling says otherwise
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

    let nl: number;
    while ((nl = pending.indexOf(0x0a)) !== -1) {
      if (nl > maxFrameBytes) return abort(); // one frame over the cap
      const line = pending.subarray(0, nl).toString("utf8");
      pending = pending.subarray(nl + 1);
      const frame = decoder.pushLine(line); // null while rpc_chunks pending
      if (frame) onFrame(frame);
    }
    if (pending.length > maxFrameBytes) abort(); // no newline in sight
  });

  // Send commands to omp stdin
  return {
    send: (cmd: RpcCommand) => proc.stdin.write(JSON.stringify(cmd) + "\n"),
    kill: () => proc.kill(),
  };
}
```

No serialization-boundary tax: the codec and the 41 `RpcCommand` /
`AgentSessionEvent` types are the same TypeScript types the renderer uses —
define them once in `packages/core`, import them from both sides.

**Registry integration:** the rpc-ui process manager shares Phase 1's session
registry and lifecycle rules (dedupe, hide/terminate, before-quit kill).
Spawning a Phase 2 session mints — or reuses, for resume — a lineage dir and
records the owned session before spawn. `--session-dir` is not optional.

### Frontend: State Machine

The frontend maintains a state machine for each session:

```ts
type OmpSessionState = {
  status: "starting" | "ready" | "running" | "error";
  messages: AgentMessage[];
  todos: TodoPhase[];
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  sessionStats: SessionStats | null;
  pendingCommands: Map<string, CommandState>;
};
```

## What You Get

- **Native advisor panel** — `<advisory>` blocks as styled cards with severity
  badges, expand/collapse, mute buttons per-advisor
- **Native diffs** — OMP's computed diffs rendered with proper syntax highlighting
- **Visual todo list** — interactive todo phases, not terminal text
- **Model selector** — dropdown with available models and thinking levels
- **Native terminal drawer** — still use xterm.js for bash commands, but as a
  collapsible drawer, not the whole main pane

## What You Lose vs Phase 1

- **Terminal fidelity** — the exact OMP TUI rendering (animations, cursor
  positioning, custom keybindings) is replaced by native components
- **New TUI features** — if OMP adds a new TUI widget, you'd need to add native
  support for it; Phase 1 gets it for free
- **Development speed** — Phase 2 is ~1.5–2 weeks of additional work for the
  rendering layer; Phase 1 is ~2 weeks and done

## Rough Timeline

| Task | Time |
|---|---|
| Handshake + frame codec (1 MiB cap, `rpc_chunk` reassembly; TS in `packages/core`) | 1 day |
| Study `AgentSessionEvent` union (the real rendering surface) | 1 day |
| Command sender + response correlation (`id`) | 1 day |
| Event dispatcher to frontend | 1 day |
| Registry/lineage integration (owned-session spawn) | 0.5 day |
| Transcript renderer over `AgentSessionEvent` (messages, thinking, tool calls) | 3 days |
| Advisor note native card renderer | 1 day |
| Diff viewer component | 1 day |
| Todo list + model selector | 1 day |
| Testing + polish | 1 day |
| **Total** | **~1.5–2 weeks** |

The transcript renderer is sized for exhaustively handling the
`AgentSessionEvent` union — that, not the 41-command inventory, is where the
time goes.
