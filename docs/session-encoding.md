# Session Storage & Encoding Reference

[Documentation home](README.md)

How OMP stores sessions on disk, verified against
`@oh-my-pi/pi-coding-agent` **v17.1.8**
(`src/session/session-paths.ts`, `session-listing.ts`, `session-entries.ts`,
`session-manager.ts`; `@oh-my-pi/pi-utils/src/dirs.ts`) and against a live
install. Re-verify on upgrade — an older release used a different directory
format (see [Legacy format & migration](#legacy-format--migration)).

**Recommended approach for the sidebar: parse session files, not directory
names.** Everything in the [Directory encoding](#directory-encoding) section is
provided for debugging and raw filesystem listing only.

## Sessions root

Default: **`~/.omp/agent/sessions/`** (note the `agent/` level).

Resolution order (`getSessionsDir()` → `dirs.agentSubdir(agentDir, "sessions", "data")`):

1. `PI_CONFIG_DIR` — config root name (default `.omp`)
2. `PI_CODING_AGENT_DIR` — full agent-dir override
3. `OMP_PROFILE` / `PI_PROFILE` — named profiles live at
   `~/.omp/profiles/<profile>/agent/sessions`
4. Linux only: if `XDG_DATA_HOME` is set, the root flattens to
   `$XDG_DATA_HOME/omp/sessions` (the `agent/` prefix is dropped)

The CLI flag **`--session-dir <path>`** pins the directory used for both storage
and `--resume` lookup. The GUI can pass this to every spawned `omp` and scan
exactly that directory — no guessing.

## Directory layout

```
~/.omp/agent/sessions/
├── -Documents-Repos-LankfordAI-omp-ui/        ← project under $HOME
│   ├── 2026-07-29T16-18-42-427Z_019faeab-cc7b-7000-8bfc-67242a2869d8.jsonl
│   └── 2026-07-29T16-18-42-427Z_019faeab-cc7b-7000-8bfc-67242a2869d8/   ← artifacts dir
│       ├── __advisor.jsonl                     ← advisor transcript(s)
│       └── PublishGate.jsonl                   ← named subagent transcript
├── -tmp/                                      ← the temp root itself (/tmp)
│   └── …
└── --var-www-html--/                          ← outside $HOME and tmp: legacy format
    └── …
```

Each session is a `<timestamp>_<uuidv7>.jsonl` file plus an optional sibling
**artifacts directory** of the same name minus `.jsonl`:

- `__advisor[.<slug>].jsonl` — per-advisor transcripts (one recorder per advisor)
- `<agentId>.jsonl` — named subagent transcripts (e.g. `PublishGate.jsonl`)

The sidebar should treat the artifacts dir as part of the session: advisor and
subagent activity is first-class data for the UI, not noise. (OMP deletes them
together — `deleteSessionWithArtifacts`.)

## Session filenames

```
<fileSafeTimestamp>_<uuidv7>.jsonl
```

`fileSafeTimestamp` = `date.toISOString()` with `:` and `.` replaced by `-`
(`session-manager.ts:93`). Example:
`2026-07-29T16-18-42-427Z_019faeab-cc7b-7000-8bfc-67242a2869d8.jsonl`.

`--resume <arg>` (case-insensitive) matches a prefix of any of
(`session-listing.ts:662`):

1. the session UUID (`019faeab…`)
2. the full basename (`2026-07-29T16-…`)
3. the basename portion after the last `_` (same UUID)

…or a direct file path. A UUID prefix is the natural choice for the GUI.

## Session file format (v3)

Newline-delimited JSON. The first line is **optionally** a fixed-width title
slot; the header follows it (slot present) or is line 1 (slot absent).
OMP's own loader (`session-loader.ts:25` `splitTitleSlot`) treats the slot as
optional, and slotless files exist — so the single rule for finding the header
is: **scan the first lines for the one with `"type":"session"`.** Never skip a
fixed byte count.

| Line | Content |
|---|---|
| Title slot (optional) | Exactly 256 bytes including the newline when present: `{"type":"title","v":1,"title":"…","source":"auto"\|"user","updatedAt":"…","pad":"…"}`. Rewritten in place when the title changes (`pad` keeps the line fixed-width). |
| Session header | `{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<ISO>","cwd":"…","title"?,"titleSource"?,"additionalDirectories"?,"parentSession"?}` |
| Entries | Each `{"type":…,"id","parentId","timestamp",…}`: `message`, `model_change`, `thinking_level_change`, `title_change`, … |

What the header gives the sidebar: `id`, `cwd`, `timestamp` (created), `title`
(may be absent early; also check the title-slot line, which the loader folds
into the header when present), `parentSession` (forks). What it does **not** give:

- **`model`** — lives in subsequent `model_change` entries
- **`status`** — derived by OMP from the file *tail*: the last assistant turn's
  end state (`complete` | `interrupted` | `aborted` | `error` | `pending` |
  `unknown`; see `SessionStatus` in `session-listing.ts`)
- **`messageCount`**, **`firstMessage`** — counted/extracted by scanning

For reference, OMP's own scanner (`session-listing.ts`) reads a 4 KiB prefix
for header + title + first message and a 32 KiB tail for status. Its
`SessionInfo`:

```ts
interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  title?: string;
  parentSessionPath?: string;   // fork parent
  created: Date;
  modified: Date;
  messageCount: number;
  size: number;                 // bytes, for compact list rendering
  firstMessage: string;
  allMessagesText: string;
  status?: SessionStatus;
}
```

Note there is no `model` field — a sidebar showing the model must parse
`model_change` entries itself.

Also on disk: orphaned-write backups named
`<basename>.jsonl.<snowflake>.bak` (OMP promotes them back to the primary on
scan; the sidebar can ignore `*.bak`) and a `.draft-only-session` marker for
draft sessions.

## Directory encoding

Verified from `getDefaultSessionDirName()` in `session-paths.ts`. The cwd is
first **canonicalized** via `resolveEquivalentPath` (symlink/alias targets
collapse to one directory name — e.g. a symlinked home or macOS
`/tmp → /private/tmp`).

### 1. cwd under `$HOME` (or `$HOME` itself)

- **Encoding**: `-` + `path.relative($HOME, cwd)` with `/`, `\`, `:` → `-`
- `$HOME` itself → literally `-`
- Examples:
  - `/home/user/projects/myrepo` → `-projects-myrepo`
  - `/home/alankford/Documents/Repos/LankfordAI/omp-ui` →
    `-Documents-Repos-LankfordAI-omp-ui` (verified live)

### 2. cwd under the temp root (`os.tmpdir()`)

- **Encoding**: `-tmp` + `-` + temp-relative with `/`, `\`, `:` → `-`
- The temp root itself → `-tmp`
- Examples:
  - `/tmp` → `-tmp` (verified live)
  - `/tmp/omp-sandbox` → `-tmp-omp-sandbox`

### 3. cwd anywhere else — legacy absolute format (still live)

- **Encoding**: strip the leading `/` or `\`, replace `/`, `\`, `:` with `-`,
  wrap in `--`
- Examples:
  - `/var/www/html` → `--var-www-html--`
  - `/mnt/data/projects/api` → `--mnt-data-projects-api--`

### Encoding function (from source)

```ts
function encodeRelativeSessionDirName(prefix: string, relative: string): string {
    const encoded = relative.replace(/[/\\:]/g, "-");
    return encoded
        ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`)
        : prefix;
}
// home:  encodeRelativeSessionDirName("-", homeRelative)
// temp:  encodeRelativeSessionDirName("-tmp", tempRelative)
// else:  `--${absolute.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
```

### Decoding

Decoding is **lossy** — `-` in real path components is indistinguishable from a
separator (`/home/user/my-project` → `-my-project` ≈ `/home/user/my/project`).
Do not decode; read the `cwd` from each session's header instead. If a raw
directory listing must be shown, display the encoded name as-is.

## Legacy format & migration

Releases before the current one encoded **home** paths as
`--<homeEncoded>-<relative>--` (e.g. `--home-user-projects-myrepo--`). On first
access to a sessions root, `migrateHomeSessionDirs()` renames these in place:
`--home-user-projects-myrepo--` → `-projects-myrepo`, `--home-user--` → `-`.

Consequences for the GUI:

- **Directory names can change under a running sidebar** when an upgraded OMP
  first touches a sessions root. Watch the root and rescan rather than caching
  names.
- The `--…--` wrapper is **not** purely historical: rule 3 above still produces
  it for paths outside home and temp. Both shapes coexist.
- If the sidebar finds sessions in a `--home-…--` directory, an old OMP wrote
  them; the header `cwd` is still authoritative.
