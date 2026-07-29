# Phase 2: RPC-UI Native Rendering

## Goal

Replace the xterm.js terminal in the main pane with native UI components by using
OMP's `--mode=rpc-ui` headless JSON protocol. The project sidebar stays the same.
The main pane renders transcripts, diffs, todos, and advisor notes as native React
components instead of terminal text.

## The Protocol

OMP's `src/modes/rpc/rpc-mode.ts` implements a bidirectional JSON protocol over
stdin/stdout:

```
┌─────────────┐        JSON stdin        ┌────────┐
│  omp-ui GUI │  ─────────────────────►   │  omp   │
│  (frontend) │  ◄──────────────────────   │  CLI   │
│            │        JSON stdout        │        │
└─────────────┘                           └────────┘
                        --mode=rpc-ui
```

### Commands to OMP (stdin)

`rpc-types.ts` defines ~40 command types:

| Command | Purpose |
|---|---|
| `negotiate_protocol` | Handshake: `{ protocolVersion: number }` |
| `prompt` | Send a user message to the agent |
| `steer` | Queue a follow-up without starting a turn |
| `follow_up` | Append to the current streaming turn |
| `abort` | Cancel the current turn |
| `new_session` | Start a new session (optionally forked from a parent) |
| `get_state` | Get current session state (model, todos, title) |
| `set_model` | Change the active model |
| `cycle_model` | Cycle to next available model |
| `get_available_models` | List models with thinking levels |
| `set_thinking_level` | Set thinking effort |
| `bash` | Execute a bash command via OMP's shell |
| `get_messages` | Get full conversation history |
| `get_messages_page` | Paginated history (cursor-based) |
| `get_session_stats` | Token usage, cost, model info |
| `switch_session` | Resume a different session |
| `branch` | Fork at a specific message ID for tree navigation |
| `set_todos` | Set the todo list phases |
| `set_host_tools` | Register tools the GUI provides (read, write, bash, etc.) |
| `compact` | Compact the conversation |
| `export_html` | Export session as HTML |

### Events from OMP (stdout)

| Event Type | Purpose |
|---|---|
| `chunk` | Streaming text update (thinking, content, tool calls) |
| `ready` | Session is ready to receive input |
| `response` | Command response (success or error) |
| `extension_ui_request` | Extension needs user input (select, confirm, input) |
| `subagent_lifecycle` | Subagent started/stopped |
| `subagent_progress` | Subagent progress update |
| `subagent_event` | Subagent event (message, tool call) |

### Extension UI Protocol

Extensions can request UI interactions:
```ts
// OMP emits:
{ type: "extension_ui_request", id: "abc", method: "confirm", title: "...", message: "..." }
{ type: "extension_ui_request", id: "def", method: "select", title: "...", options: ["a", "b"] }
{ type: "extension_ui_request"; id: "ghi", method: "input", title: "...", label: "..." }

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
- Message type (user, assistant, tool_result)
- Thinking content
- Tool calls with arguments and results
- **Advisor advisories** (the `<advisory>` blocks — now native cards)
- Cost info per model

### Diff Viewer

OMP computes diffs for edit/write operations. The RPC stream includes
`diffResult` frames. Render them with a native diff component:

```tsx
<DiffViewer
  oldPath="src/auth.ts:old"
  newPath="src/auth.ts:new"
  changes={diffResult.changes}
/>
```

### Todo List

OMP's todo tool emits phase data. The `set_todos` command and todo-related
events provide the structured data:

```tsx
<TodoList phases={phases} onUpdate={setTodos} />
```

### Model Selector

```tsx
// get_available_models returns model objects with thinking levels
// set_model selects one
<ModelSelector
  models={availableModels}
  currentModel={currentModel}
  onSelect={(model) => sendCommand({ type: "set_model", ... })}
/>
```

## Architecture Changes

### Backend: Process Manager (Rust → TypeScript)

Phase 1 used Rust via Tauri's backend. Phase 2 moves the OMP process to a
Node.js sidecar that speaks the JSON protocol:

```
┌──────────────────┐       ┌─────────────────────┐       ┌──────────┐
│  Tauri frontend  │  IPC  │  Node sidecar (Tauri) │  stdio │  omp CLI │
│  (Svelte/React)  │──────►│  (JSON protocol)      │──────►│  --rpc-ui │
└──────────────────┘       └──────────────────────┘       └──────────┘
                            (or run directly from Tauri)
```

Actually, Tauri can spawn the process and manage it from the Rust side using
`portable-pty` or `tokio::process`. The difference from Phase 1 is that instead
of streaming raw terminal bytes, you parse JSON frames:

```rust
// Read newline-delimited JSON from omp stdout
let reader = BufReader::new(master);
for line in reader.lines() {
    let value: serde_json::Value = serde_json::from_str(&line)?;
    // emit as typed event to frontend
    app_handle.emit_all("omp-event", value).unwrap();
}

// Send commands to omp stdin
async fn send_command(cmd: RpcCommand) {
    let json = serde_json::to_string(&cmd)?;
    stdin.write_all(format!("{}\n", json).as_bytes()).await?;
}
```

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
- **Development speed** — Phase 2 is ~2 weeks of additional work for the
  rendering layer; Phase 1 is ~1 week and done

## Rough Timeline

| Task | Time |
|---|---|
| Study RPC protocol types from source | 1 day |
| JSON frame parser (stdin/stdout) | 1 day |
| Event dispatcher to frontend | 1 day |
| Command sender (stdin) | 1 day |
| Transcript renderer (messages, thinking, tool calls) | 2 days |
| Advisor note native card renderer | 1 day |
| Diff viewer component | 1 day |
| Todo list + model selector | 1 day |
| Testing + polish | 1 day |
| **Total** | **~1 week** |
