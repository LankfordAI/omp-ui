# Provider credentials are omp-ui's problem, and they ride `process.env`

omp authenticates from environment variables. A GUI launched from a `.desktop`
entry, an AppImage, or a dock icon inherits the session manager's environment —
never `~/.zshrc` — so omp starts with **no credentials** and its model catalog
silently collapses to whatever providers need no auth.

omp-ui therefore owns a credential set and installs it into its own
`process.env` before any session can spawn. Users can also type keys into a
Providers settings page, stored encrypted by the OS credential store.

## The bug this came from

Measured on a real install (omp 17.1.8), not inferred:

- The model picker offered **6 models, `vllm` only**. `omp models --json` in the
  user's terminal returned **413 openrouter + 6 vllm**; the same command with
  `env -u OPENROUTER_API_KEY` returned **vllm only** — the catalog is
  credential-gated, so a missing key reads as a missing provider.
- `OPENROUTER_API_KEY` was exported on line 128 of `~/.zshrc` and nowhere else.
  The running Electron main process had it **unset**, and so did the `omp` child
  it spawned (`/proc/<pid>/environ`).
- `omp token openrouter` without the variable: `No active credential found` —
  nothing on omp's own broker either. The key existed only in a file no GUI
  launch reads.

## Why `process.env`, not per-spawn plumbing

Every launch path already spreads `process.env`: `rpc/client.ts` (rpc-ui),
`pty.ts` (`spawnOmp` and the console-drawer shell), and `title-model.ts` (the
title and branch-name runs). Installing resolved values in one place fixes all
of them and changes no signature. Threading an `env` parameter through four call
sites would add a way to *forget* one — a session that works while its title
generation silently 401s is worse than either outcome.

## Precedence, and why stored wins

Highest priority first: **stored** (typed in-app), **environment** (genuinely
inherited), **login-shell** (captured), **dotenv** (report-only).

- **Stored outranks inherited** because the alternative is unfixable: with a
  stale variable in the environment, typing a key would appear to do nothing.
  The page says when a stored key is shadowing an ambient one rather than
  leaving the user to wonder.
- **Login-shell capture** runs `$SHELL -ilc` and asks for exactly the catalogued
  variable names, one `NAME=value` line each. `-i` is load-bearing: `-lc` alone
  sources only profile files and returned nothing here, because the export lives
  in the interactive `~/.zshrc`. Never the whole environment — an unrelated
  variable holding a secret is not read at all.
- **Project `.env` is reported, never injected.** omp loads `.env` and
  `.env.local` itself (verified: a key in the project `.env` yields the full
  catalog). Injecting them here would duplicate omp's loader and its precedence.
  They are still surfaced so a key that already works is never labelled "not
  set".

## Consequences

- **`basic_text` counts as no encryption.** Electron's safeStorage falls back to
  a hardcoded key when no keyring is present. `electronKeyCipher` reports that as
  unavailable and the write is *refused* with a message pointing at the shell,
  rather than writing a decodable secret to disk under an "encrypted" label. On
  this machine the backend is `gnome_libsecret`.
- **Key material never crosses the IPC boundary.** The renderer receives a
  masked tail (`••••cdef`) and a source label. There is no "reveal" — unlike the
  remote-access token, which omp-ui mints and the user must copy, these are the
  user's own secrets held on their behalf.
- **Only catalogued variable names are writable.** `setKey` rejects anything
  outside `PROVIDER_KEY_SPECS`, so the channel cannot be turned into arbitrary
  environment injection into a child process (`LD_PRELOAD` is the obvious one).
- **Interior whitespace is refused.** Every credential in the catalog is an
  opaque token, so a value containing whitespace is a mis-paste — a whole
  `export NAME=…` line, a PEM — and is rejected instead of being stored as a
  credential that could never work. Surrounding whitespace is trimmed.
- **An undecryptable entry is dropped, not fatal.** After a keyring change the
  blob is intact but foreign, and indistinguishable from corruption. The row
  reports as unset so the user can retype it.
- **Keys bind at process start.** A key added now applies to the next session
  spawn; live sessions need the existing restart. Same constraint as ADR-0005.
- **AWS/Vertex credentials are deliberately absent** from the catalog:
  `AWS_PROFILE`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_APPLICATION_CREDENTIALS`
  are a profile name, a project id, and a file path. A "paste your key" field is
  the wrong shape for all three, and a half-right control is worse than none.
