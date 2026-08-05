# AppImage as the sole first-party Linux artifact, via a staged bridge

Linux releases currently ship four formats — AppImage, deb, rpm, and a
standalone Flatpak bundle — but only the AppImage updates in place. deb, rpm,
and Flatpak users must download an installer, authorize it, and manually
relaunch on every update. The research report
[../research/appimage-only-linux-distribution.md](../research/appimage-only-linux-distribution.md)
evaluated an AppImage-only cutover against the T3 Code reference experience,
including the delta, migration risks, and a staged rollout/rollback plan. Its
recommendation — GO, but only via a mandatory all-format bridge release gated
on a tested graphical per-user installer — is accepted.

## Considered Options

- **Keep all four formats (rejected)** — deb/rpm/Flatpak updates stay manual
  and disruptive, which is the problem that motivated the evaluation.
- **Immediate AppImage-only cutover (rejected)** — legacy installs select an
  exact same-format asset from each release; when that asset disappears they
  dead-end at `expected asset missing from release` and cannot learn a
  migration path after the fact.
- **Flatpak with a real repository (rejected for now)** — does not address
  rpm/deb users and adds repository operations.
- **Staged bridge to AppImage-only (chosen)** — one final all-format bridge
  release whose updater routes legacy installs through the same graphical
  per-user installer used by fresh downloads, then cut over to AppImage-only
  once the bridge gates are green.

## Consequences

- "AppImage-only" means the sole first-party, supported Linux artifact;
  community packages are tolerated but unsupported.
- The canonical install path is `$HOME/.local/bin/omp-ui.AppImage`,
  unversioned. The AppImage is its own graphical installer (install,
  idempotent repair, data-preserving uninstall) and owns the per-user
  `ai.lankford.omp-ui.desktop` entry and hicolor icons.
- The cutover is NO-GO until: the bridge release has migrated every legacy
  format through the shared installer; a fresh browser download installs,
  repairs, and uninstalls with no terminal on GNOME and KDE; the Beta static
  AppImage runtime (`toolsets.appimage` `1.0.3`) passes a distro smoke
  matrix; and Flatpak userData/provider-key migration is proven.
- The updater explicitly sets `autoInstallOnAppQuit = false`; restart warns
  with the live-session count and preserves no running work.
- Legacy packaging source and workflow are retained through one stable
  post-cutover cycle so rollback stays a revert, not a reconstruction.
- Implementation is tracked by future issues; this ADR records the decision
  only.
