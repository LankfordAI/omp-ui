# Phase 1: PTY Embed (Tauri + portable-pty + xterm.js)

## Goal

Embed the full OMP TUI inside a Tauri desktop window with a project sidebar.
The OMP TUI runs unmodified — every keybinding, theme, skill, and advisor note
renders through xterm.js. This is literally "terminal-in-a-window" with session
management on top.

## Session Management

### Session storage location

OMP stores sessions under `~/.omp/sessions/`. Each subdirectory corresponds to a
project (working directory). Each `.jsonl` file is a session.

### Strategy: Read session headers (primary)

Each `.jsonl` session file begins with a JSON header line:
```json
{"type":"session","version":...,"cwd":"/home/user/projects/myrepo",...}
```

**Read the header, not the directory name.** Each session's `cwd` is stored in
its header. To populate the sidebar:

1. Walk `~/.omp/sessions/` — each subdirectory is a project group.
2. For each `.jsonl` file, read the first JSON line to extract `cwd`, `title`,
   `model`, `status`, and `modified` timestamp.
3. Group sessions by `cwd` for the tree view.

This is encoding-agnostic — it survives OMP upgrades that change the directory
naming scheme.

### Directory encoding (secondary/context only)

For debugging or raw filesystem listing without parsing headers, OMP encodes
the project path into the subdirectory name (`session-paths.ts`). If you need
to decode:

- **Home-relative**: `--<relative-path>--`
  - `/home/user/projects/myrepo` → `--home-user-projects-myrepo--`
  - Encoding: `relative.replace(/[/\\:]/g, "-")` wrapped in `--`
- **Temp-root**: `--tmp-<relative>--`
  - `/tmp/omp-sandbox` → `--tmp-omp-sandbox--`
  - Temp root is system-specific (e.g. `/tmp`, `$TMPDIR`)
- **Absolute (elsewhere)**: `--<path>--`
  - `/var/www/html` → `--var-www-html--`
  - Encoding: `resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")` wrapped in `--`

**Verify on upgrade:** If the sidebar stops finding sessions after an OMP update,
fall back to reading raw `.jsonl` headers (the primary strategy above) — it does
not depend on directory encoding.

### SessionInfo fields (from `session-listing.ts`)

```ts
interface SessionInfo {
  path: string;          // full path to the .jsonl file
  id: string;            // UUIDv7 — pass as --resume <prefix>
  cwd: string;            // decoded project path (from header)
  title?: string;         // session name
  status?: SessionStatus;  // complete | interrupted | aborted | error | pending | unknown
  created: Date;
  modified: Date;
  messageCount: number;
  model?: string;         // via session header
}
```

### Launching OMP

**New session in a project:**
```bash
omp --cwd=<project-path>
```

**Resume a session:**
```bash
omp --resume=<session-id-prefix>
```

The `--resume` flag accepts an ID prefix, file path, or session path — no picker
interaction needed when the ID is provided.

**With advisor:**
```bash
omp --cwd=<path> --advisor
```

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend | **Tauri** (Rust) | ~10MB binary vs Electron's ~300MB; native PTY without Node |
| Process PTY | **portable-pty** (Rust crate) | From wezterm; spawn/resize/read PTY natively, no node-pty build issues |
| Terminal | **xterm.js** + `xterm-addon-fit` + `xterm-addon-web-links` | Mature; same lib T3 Code uses |
| UI framework | **Svelte** or **React** | Your call |
| State | **Zustand** or Svelte stores | Simple, no boilerplate |
| Session parsing | Read JSONL headers via Rust `serde_json` | No OMP API dependency |

## Implementation Steps

### Step 1: Tauri project scaffold
```bash
npx create-tauri-app omp-ui --template svelte
cd omp-ui
cargo add portable-pty
npm i xterm xterm-addon-fit xterm-addon-web-links
```

### Step 2: PTY spawn command
Spawn `omp` via `portable-pty`:

```rust
// src-tauri/src/pty.rs
use portable_pty::{CommandBuilder, NativePaneMarker, PtySize};

pub fn spawn_omp(cwd: &Path, cols: u16, rows: u16, advisor: bool) -> Result<PtySession> {
    let pty = native_pty_system()
        .open_pty(PtySize { cols, rows })?;
    
    let mut cmd = CommandBuilder::new("omp");
    cmd.arg("--cwd").arg(cwd.to_string_lossy());
    if advisor {
        cmd.arg("--advisor");
    }
    
    let mut child = pty.spawn_command(cmd)?;
    Ok(PtySession { child, master: pty.master })
}
```

### Step 3: Stream output to frontend
PTY master reads are piped via Tauri `emit_all` events:

```rust
// In async task:
let mut output = [0u8; 4096];
loop {
    match master.read(&mut output) {
        Ok(n) => {
            let text = String::from_utf8_lossy(&output[..n]);
            app_handle.emit_all("pty-output", text).unwrap();
        }
        Err(_) => break,
    }
}
```

```ts
// Frontend: listen for PTY output
import { listen } from '@tauri-apps/api/event';
import { Terminal } from 'xterm';

const term = new Terminal();
term.open(document.getElementById('terminal'));

listen('pty-output', (event) => {
    term.write(event.payload as string);
});
```

### Step 4: Input handling
Frontend sends keystrokes to PTY master:

```ts
term.onData((data) => {
    fetch('/api/pty-input', {
        method: 'POST',
        body: data,
    });
});
```

```rust
// Tauri command:
#[tauri::command]
fn write_pty(data: String) {
    // write to PTY master
}
```

### Step 5: Session sidebar
Scan `~/.omp/sessions/` at startup and on-demand:

```rust
fn list_sessions() -> Result<Vec<ProjectGroup>> {
    let sessions_root = home.join(".omp").join("sessions");
    let mut groups: Vec<ProjectGroup> = vec![];
    
    for dir in std::fs::read_dir(&sessions_root)? {
        let dir = dir?;
        let cwd = read_header_cwd(&dir.path())?;  // parse one .jsonl header
        let mut sessions = vec![];
        
        for file in std::fs::read_dir(&dir.path())? {
            let file = file?;
            if file.path().extension().map_or(false, |e| e == "jsonl") {
                sessions.push(parse_session_header(file.path())?);
            }
        }
        
        groups.push(ProjectGroup { cwd, sessions });
    }
    
    Ok(groups)
}
```

### Step 6: Resize handling
Forward terminal resize to the PTY:

```ts
window.addEventListener('resize', () => {
    fetch('/api/pty-resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cols: term.cols,
            rows: term.rows,
        }),
    });
});
```

## What You Get For Free

- **Full OMP TUI** — themes, skills, slash commands, keybindings
- **Advisor notes** — rendered through OMP's own `<advisory>` system in the TUI
- **Advisor cost** — status line shows `$2.67 (sub) + $0.41 (adv)`
- **Per-advisor config** — WATCHDOG.yml files work as-is
- **No agent logic reimplementation** — OMP handles everything; you just embed it

## Rough Timeline

| Task | Time |
|---|---|
| Scaffold Tauri + deps | 1 day |
| PTY spawn + output streaming | 2 days |
| xterm.js terminal widget | 1 day |
| Input handling + resize | 1 day |
| Session scanner + sidebar | 2 days |
| Project tree + session switching | 1 day |
| Build/release config | 1 day |
| **Total** | **~1 week** (for basic working v0) |
