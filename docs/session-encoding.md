# Session Encoding Reference

OMP encodes project paths into session directory names under `~/.omp/sessions/`.
This document captures the encoding rules verified from `src/session/session-paths.ts`
so the sidebar can decode them if needed — though the recommended approach is to
**read session headers** (encoding-agnostic).

## Directory Layout

```
~/.omp/sessions/
├── --home-user-projects-myrepo--          ← home-relative: /home/user/projects/myrepo
│   ├── 2026-07-28-10-30-00_a1b2c3d4.jsonl
│   └── 2026-07-28-09-15-00_e5f6g7h8.jsonl
├── --tmp-omp-sandbox--                    ← /tmp/omp-sandbox
│   └── 2026-07-28-08-00-00_i9j0k1l2.jsonl
└── --var-www-html--                       ← /var/www/html
    └── 2026-07-28-07-00-00_m3n4o5p6.jsonl
```

## Encoding Rules

Verified from `getDefaultSessionDirName()` and helper functions in
`session-paths.ts`:

### 1. Home-relative paths
When the cwd is under `$HOME`:
- **Encoding**: `path.relative($HOME, cwd)` → replace `/`, `\`, `:` with `-`
- **Format**: `--<encoded-relative>--`
- **Examples**:
  - `/home/user/projects/myrepo` → `--home-user-projects-myrepo--`
  - `/home/user` → `--` (the home dir itself, encoded `home` becomes `--home--`)

### 2. Temp-root paths
When the cwd is under the system temp directory (`$TMPDIR`, `/tmp`, etc.):
- **Encoding**: `path.relative(tmpRoot, cwd)` → replace `/`, `\`, `:` with `-`
- **Format**: `--tmp-<encoded-relative>--`
- **Examples**:
  - `/tmp/omp-sandbox` → `--tmp-omp-sandbox--`
  - `/var/folders/xx/yy/T/myproject` → `--tmp-var-folders-xx-yy-T-myproject--`

### 3. Absolute paths (elsewhere)
When the cwd is outside `$HOME` and temp:
- **Encoding**: `resolvedCwd` with leading `/`, `\`, `:` stripped, then all `/` and
  `:` replaced with `-`
- **Format**: `--<sanitized-absolute-path>--`
- **Examples**:
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
```

### Decoding

To reverse the encoding:
1. Strip leading `--` and trailing `--`
2. If starts with `tmp-`, it's a temp-root path → strip `tmp-`, resolve relative to temp root
3. If starts with `home`, it's a home-relative path → prepend `$HOME/`
4. Otherwise, reconstruct by replacing `-` with `/`

**Warning**: Decoding is lossy if project paths contain `-` characters. For example:
- `/home/user/my-project` encodes to `--home-user-my-project--`
- This could also decode to `/home/user/my/project` (with `/` between `my` and `project`)

**Recommendation**: Decode by trying `path.resolve($HOME, decoded)` and checking if the
directory exists. Fall back to showing the raw directory name if decoding fails.

## Recommended Approach: Read Session Headers

Each session `.jsonl` file starts with a JSON header:

```json
{"type":"session","version":...,"cwd":"/home/user/projects/myrepo",...}
```

**Always parse the `cwd` from this header instead of decoding the directory name.**
This is:
- Encoding-agnostic (survives OMP encoding changes)
- Not lossy (the exact cwd is stored)
- Simpler (no decode/reconstruct logic)

The sidebar should:
1. List directories under `~/.omp/sessions/`
2. For each `.jsonl` file, read the first JSON line to get `cwd`, `title`, `status`
3. Group sessions by the `cwd` from the header

**Verify on upgrade**: If a future OMP version changes the directory encoding, the
sidebar still works because it reads headers, not directory names.
