# AppImage as the sole first-party Linux artifact, via a staged bridge

> **Status note:** The staged cutover below is complete. AppImage is now the
> sole supported Linux artifact. See the [current architecture](../architecture.md)
> and [user guide](../user-guide.md).

Linux releases currently ship four formats — AppImage, deb, rpm, and a
standalone Flatpak bundle — but only the AppImage updates in place. deb, rpm,
and Flatpak users must download an installer, authorize it, and manually
relaunch on every update. The research report
[../research/appimage-only-linux-distribution.md](../research/appimage-only-linux-distribution.md)
evaluated an AppImage-only cutover against the T3 Code reference experience,
including the delta, migration risks, and a staged rollout/rollback plan. Its
recommendation — GO, but only via a mandatory all-format bridge release gated
on a tested per-user installer — is accepted.

## Considered Options

- **Keep all four formats (rejected)** — deb/rpm/Flatpak updates stay manual
  and disruptive, which is the problem that motivated the evaluation.
- **Immediate AppImage-only cutover (rejected)** — legacy installs select an
  exact same-format asset from each release; when that asset disappears they
  dead-end at `expected asset missing from release` and cannot learn a
  migration path after the fact.
- **Flatpak with a real repository (rejected for now)** — does not address
  rpm/deb users and adds repository operations.
- **Graphical per-user installer (rejected)** — the research report gated the
  bridge on a no-terminal, AppImage-embedded graphical flow. omp-ui's
  audience installs developer tools with `curl | bash` already (opencode,
  omp, bun); a GUI doubles the work (the flow itself plus a GNOME/KDE smoke
  matrix) for no onboarding benefit, and a script stays the engine under any
  future GUI.
- **Staged bridge to AppImage-only (chosen)** — one final all-format bridge
  release whose updater routes legacy installs through the same per-user
  install script used by fresh downloads, then cut over to AppImage-only
  once the bridge gates are green.

## Consequences

- "AppImage-only" means the sole first-party, supported Linux artifact;
  community packages are tolerated but unsupported.
- The canonical install path is `$HOME/.local/bin/omp-ui.AppImage`,
  unversioned and user-writable so electron-updater can replace it in place.
  The canonical installer is `packaging/install.sh` — an opencode-style
  `curl | bash` script (#69) with sha256-verified download, idempotent
  repair on re-run, and a data-preserving `--uninstall`; it owns the
  per-user `ai.lankford.omp-ui.desktop` entry and hicolor icons.
- The cutover is NO-GO until: the bridge release has migrated every legacy
  format through the shared installer; a fresh `install.sh` run installs,
  repairs, and uninstalls with no root and no desktop-environment-specific
  behavior (CI-headless checks: the AppImage launches,
  `desktop-file-validate` passes, re-run repairs, uninstall preserves
  userData); the Beta static AppImage runtime (`toolsets.appimage` `1.0.3`)
  passes a distro smoke matrix; and Flatpak userData/provider-key migration
  is proven.
- AppImage checks stage the sha512/blockmap-verified update in the background.
  `autoInstallOnAppQuit` remains false unless the user explicitly chooses
  "Install when I quit" for that staged update; Restart now still warns with
  the live-session count, and neither path preserves running work.
- Legacy packaging source and workflow are retained through one stable
  post-cutover cycle so rollback stays a revert, not a reconstruction.
- Implementation is tracked by #69 (install script) and follow-up issues for
  the bridge handoff and the cutover; this ADR records the decision only.

**Amended 2026-08-05 (#69):** the installer is a shell script, not a
graphical flow; the research report's "no terminal at any point" gate is
superseded — the required desktop integration is the per-user entry and
hicolor icons the script creates.

**Amended 2026-08-05 (#74):** the bridge release was skipped. The maintainer
is currently the sole user, and the only legacy install (rpm) was migrated
to the AppImage and removed before the cutover — corroborated by zero
external downloads of the v0.4.0 deb/rpm/Flatpak assets and no
`latest-linux.yml` updater traffic. With no legacy installs to strand, the
`expected asset missing from release` dead-end has no victims, so deb/rpm
were dropped from `electron-builder.yml` and the standalone Flatpak lane was
removed in the same cycle. Rollback remains `git revert` of the cutover
commit. The app-side deb/rpm/Flatpak updater paths (format detection, asset
selection, checksum download) stay for the rollback window and are the
scheduled cleanup after one stable AppImage-only cycle.

**Amended 2026-08-06 (#99):** staging is no longer click-gated. A background
check downloads and verifies the AppImage before showing the update card, so
Restart now has no download wait. The hardcoded `autoInstallOnAppQuit = false`
became an explicit per-process opt-in: "Install when I quit" arms the staged
update for the next natural quit, while the default remains no silent install.
