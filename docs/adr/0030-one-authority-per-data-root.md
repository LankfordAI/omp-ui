# One authority per data root: publish-and-prove lock, children ledger, journalled migration

## Status

Accepted (decided now, effective at release C; release P builds and tests the
machinery and plants the legacy tripwire). Issues
[#442](https://github.com/LankfordAI/omp-ui/issues/442) §6,
[#450](https://github.com/LankfordAI/omp-ui/issues/450) (lock, root, journal),
[#451](https://github.com/LankfordAI/omp-ui/issues/451) (credential envelope),
[#457](https://github.com/LankfordAI/omp-ui/issues/457) (cutover order).
Companion to [ADR-0029](0029-persistent-host-owns-authoritative-application.md).

## Context

OMP has no cross-process session lock, so two omp-ui processes that both
reach `Registry.load` for one data root can resume one owned session twice
and write one JSONL transcript from two children. Until now the only guard was
Electron's `requestSingleInstanceLock()`, scoped to `userData` and invisible
to any non-Electron process. Once the persistent host exists (ADR-0029) that
guard covers nothing: a host and a pre-cutover Electron build, two hosts from
two checkouts, a host and the children a `SIGKILL`ed host left behind, or a
host and the store it is halfway through relocating are all two writers over
one root. Node offers no portable advisory-lock call (`O_EXLOCK` is undefined
on Linux; there is no `FileHandle.lock`), and a native binding would fork the
recovery semantics per platform.

The migration itself is the other hazard: Electron's stores must move from
`userData` to the host root, and provider and joined-instance credentials are
Electron `safeStorage` ciphertext that only Electron can read. A copy leaves
two complete live stores for a window; a lazy re-encrypt on first read turns
"not migrated yet" into "key gone", because `ProviderKeys` silently dropped an
undecryptable blob.

## Decision

**The claim is a filesystem transaction with proof of death, not a lock
syscall** (`packages/host/src/authority/lock.ts`, `authority.ts`). A claimant
writes `<dataRoot>/locks/host-<random>/owner.json` — `{ pid, bootId,
processStartMs, startedAtMs, incarnation, hostVersion, dataRoot, flavor }` —
and publishes it with one `link(2)` to the permanent name
`<dataRoot>/host.lock`. `link` is atomic and fails `EEXIST` when the name
exists, so exactly one `owner.json` is ever reachable through it.

- **Contended (`EEXIST`).** The claimant reads the connection record and
  probes its endpoint. An authenticated answer is a *veto*: a live host owns
  the root, the claimant throws `AuthorityConflict("live host")` naming pid,
  version, and endpoint, and exits. A failed probe authorises nothing — it
  may be a half-started host in a boot race.
- **Takeover only on evidence.** The recorded owner must be provably gone:
  its `bootId` is not this kernel's boot, or its pid is dead on this boot, or
  the pid is alive but its process start time disagrees with the record
  (`process-identity.ts`: `alive` / `dead` / `unverifiable`, never
  "unverifiable means dead"). An owner that is alive, or that the platform
  cannot classify, is a refusal (`owner alive`, `owner unverifiable`) — killing
  it is a human act. The single-winner step is another `link`: the inspected
  `host.lock` inode is linked to `host.lock.stale-<incarnation>`; a contender
  who finds that name taken, or finds it landed on a different inode, lost the
  race. Only then does the winner `rename` its `owner.json` over `host.lock`,
  so the name never disappears and no live owner is displaced. There is never
  a bare rename of an unproven lock and `host.lock` is never unlinked as
  cleanup.
- **Assertion while running.** The two names are hard links to one inode, so
  `stat(host.lock).ino === ownIno` answers "am I still the owner" with no
  lease, heartbeat, or clock; `claimAuthority` re-checks every 30 s
  (`LOCK_ASSERT_INTERVAL_MS`) and a mismatch records a breadcrumb and exits
  the process with status 5 (`LOCK_LOST_EXIT_CODE`) — no re-acquire, no
  degraded mode. Without a lease, a suspended machine resumes into the same
  lock rather than an expired one.
- **Sweep only what is proven dead.** `locks/host-*` dirs and
  `host.lock.stale-*` names whose recorded owner fails the same proof are
  removed by the next holder; nothing else is.

**`AuthorityToken` is the only route to authoritative state.** `claimAuthority`
mints `{ dataRoot, incarnation }`; `Registry.load` and the resume seam demand
it, so a store reached without a claimed lock is a type error rather than a
boot-sequence convention. In release P only, `claimLegacyElectronAuthority`
mints the same witness for Electron main after Chromium's lock and the
tripwire below; it is deleted at C.

**The children ledger makes the crash survivor the only resumer**
(`packages/host/src/authority/children-ledger.ts`). The lock stops two hosts;
it does not stop an `omp` child a killed host left writing into a lineage dir
(the rpc-ui child is a pipe child and gets no parent-death signal). Every
spawn appends `{ pid, pgid, bootId, procStartMs, executable, kind:
pty|rpc-ui|shell, tabId, lineageDir }` to `<dataRoot>/runtime/children.json`
durably before it is reported; every reap removes it. `reconcileBeforeLoad`
runs before `Registry.load`: entries from another boot died with it; dead
pids are dropped; live, identity-matching children get `SIGTERM` → 3 s →
`SIGKILL` → 2 s against their recorded process group (the pid alone when the
group is not ours), awaited; anything unverifiable or still alive stays in
the ledger and stops the boot by pid (`LedgerUnresolved`). Never "assume
dead", never resume beside it.

**Every durable store change is a journalled step**
(`packages/host/src/migration/journal.ts`). `<dataRoot>/migration.json` is an
ordered list of steps `{ id, status: open|committed, items[], startedAtMs,
committedAtMs }`, rewritten with `writeTextDurably` (fsync file → rename →
fsync directory) before and after each mutation. The step ids are frozen:
`relocate-authority-stores-v1`, then `credential-handoff-v1`; an unknown id or
an unreadable journal is a `MigrationConflict`, so a downgrade fails closed.

- **Relocation** (`relocate.ts`) moves exactly six items from Electron's
  pinned `userData` — `registry.json`, `provider-keys.json`,
  `remote-instances.json`, `oauth-login/`, `worktrees/`, `logs/` — recording
  `{ source, destination, mode, size, mtimeMs, dev, ino }` per item before
  touching it. Same device: one `rename`, then fsync the parent. `EXDEV`:
  copy to a staging name, verify by fingerprint, publish, verify again, drop
  the source. Replay classifies each item: **no evidence** — move it, or stop
  if the destination already exists without journal evidence (someone else's
  store); **source only** — redo from the source as it is now; **destination
  only** — done; **neither** — the journal disagrees with disk, stop; **both**
  — dedupe only when the source's `dev+ino` still match the evidence *and*
  both trees fingerprint identically, otherwise stop and touch neither. Before
  the step commits, every registered worktree checkout is re-linked with
  `git worktree repair` from its project's main working tree and the record's
  `worktree.path` is rewritten; a checkout that cannot be repaired keeps its
  moved path and is marked resume-unavailable, never silently relaunched at
  the project root.
- **Credential handoff** (`credential-handoff.ts`) runs after relocation and
  before `Registry.load`, per stored value: a host envelope is kept;
  plaintext the Electron reader recovers is re-encrypted; a `locked` blob
  (keyring or Keychain unreadable right now) is left byte-for-byte and keeps
  the step open for a later run; a `foreign` blob (not `safeStorage`'s, or
  another account's) is dropped for a provider key with a named breadcrumb,
  while a joined instance keeps its record with a null credential and reads
  *sign-in required*. Plaintext never lands on disk.

**One host envelope under a protector-held DEK**
(`packages/host/src/credentials/`). Every provider key and joined-instance
credential is `0x02 || nonce[12] || ciphertext || tag[16]`, AES-256-GCM with a
fresh nonce under a 32-byte per-root data encryption key. The OS store holds
only the DEK: Secret Service on Linux (no keyutils fallback), Keychain on
macOS, DPAPI on Windows (`CurrentUser`, wrapping `<dataRoot>/master.key`).
`KeyCipher.encrypt/decrypt` stay synchronous and make no OS call; the DEK is
read once at boot on a `worker_threads` Worker with a hard 5 s deadline
(`DEK_WORKER_TIMEOUT_MS`) that terminates a wedged keyring call. `0x01`
marks Electron ciphertext met mid-handoff and is a migration bug, never a
lost key; unprefixed `v10`/`v11` is legacy Electron output. `openHostKeyCipher`
never throws: an unreachable, timed-out, or empty store yields a
`DegradedCipher` that reports its backend and reason and **fails closed** —
nothing is written that cannot later be read, and with ciphertext on disk a
missing DEK is `key-lost`, never a fresh key that would orphan it. A degraded
host still starts: it reports zero stored keys, injects only inherited and
login-shell provider sources, and refuses stored-key writes and credential
joins.

**The legacy Electron tripwire ships in release P**
(`packages/core/src/data-root.ts`, `packages/desktop/src/main/authority-tripwire.ts`).
A pre-cutover Electron build refuses to start when the canonical root carries
any `AUTHORITY_CLAIM_MARKERS` — `host.lock`, `migration.json`,
`registry.json`, `provider-keys.json`, `remote-instances.json`, or
`worktrees/`. This is filesystem evidence, deliberately not a liveness probe:
a crashed or half-migrated host is exactly when an empty Electron registry
beside it would be most dangerous. The refusal names the root and `omp-ui
status`, `omp-ui stop`, and `omp-ui rollback`, logs and breadcrumbs it, and
exits with status 5 before any registry or credential read. Already-published
binaries older than P cannot be taught this and are unsupported against a
migrated root.

**Boot order is one sequence** (`packages/host/src/serve.ts`) for first run,
restart, crash recovery, and post-update relaunch: resolve and canonicalise
the root → publish the claim and mint the token → reconcile the children
ledger → replay/advance the journal (relocation, then credential handoff) →
open the protector and cipher → `Registry.load` under the token (`stop` on a
corrupt file: nothing is quarantined) → write `host.json` → hydrate → first
request or spawn. Every failure after the claim releases the token and
removes `host.json` before the process exits 1; a conflict exits 5.

## Considered options

- **Per-platform advisory locks or a port bind (rejected).** Node has no lock
  primitive on Linux; a native binding forks the crash semantics; a port bind
  makes an availability decision masquerade as a lock. Correctness rests on
  `link`/`rename` atomicity plus proof of death.
- **Adopt Electron's `userData` in place (rejected).** The authority for a
  display-independent process should not live inside the client's Chromium
  profile under the client's name; a real filesystem boundary is what makes
  "clients own no authoritative state" checkable.
- **Copy-all migration or a marker file (rejected).** Copy-all leaves two
  complete live stores for a window; a marker leaves a partial move
  undiagnosable. The per-item rename journal with "both ⇒ prove, then dedupe"
  does neither.
- **One uniform quarantine policy (rejected).** Quarantine-and-start-empty is
  right for a store this authority already owns and is data loss for one it
  has not yet adopted; before adoption an unreadable store stops the host with
  every file in place.
- **Lazy credential re-encryption or a dual-read window (rejected).** The
  silent drop on decrypt failure made a late handoff lossy, and two decrypt
  paths is the shape #442 §9 forbids; the per-blob format byte with a
  pre-load step is re-entrant without whole-file state.
- **A boot-sequence convention instead of `AuthorityToken` (rejected).** The
  ordering that broke — registry load and env injection from a constructor —
  is exactly what a witness type makes impossible.

## Consequences

- `serve` claims; `status` never constructs `Registry` (it reads the record
  and probes, and may read `host.lock` read-only for owner detail); `stop`
  asks the live host to exit and never deletes the lock; `service uninstall`
  preserves the data root unless told otherwise. Every authority-taking path
  refuses with the same actionable line — owner pid, version, start time,
  flavor, endpoint, and the two remedies: connect through the live host, or
  `omp-ui stop`. No path waits and steals.
- A host update releases the token and lock before its replacement claims;
  the old process may stay alive only as a non-authoritative handover arbiter.
  Unknown future journal steps fail closed, which is what makes a rollback
  safe.
- The root is selected by build flavor, never by launch path or
  `OMP_PROFILE`; two dev hosts from two checkouts contend and the second
  refuses. A root nested inside another flavor's root is a fatal configuration
  error (`canonicalDataRoot`).
- `writeTextDurably` joins core for the journal, the connection record, the
  ledger, and both credential stores; `registry.json` keeps the cheap
  rename-only `writeTextAtomic` because its writes sit on interactive paths.
- Legacy relocation and credential readers remain isolated to the adoption
  path until two later minor releases have shipped *and* twelve months have
  passed since C; a newer host then fails closed with an instruction to run
  release C as the bridge, never starting empty or quarantining an unadopted
  store.
