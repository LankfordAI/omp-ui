---
status: accepted
---

# Unsigned per-user NSIS for the Windows x64 preview

Windows previews ship as assisted, per-user x64 NSIS installers from GitHub Releases. They remain unsigned until omp-ui can use a publicly trusted OV/EV Authenticode certificate or Azure Trusted Signing: a self-signed certificate would not establish publisher identity on users' machines or remove SmartScreen friction.

## Considered Options

- **Self-signed Authenticode certificate (rejected)** — public Windows machines do not trust it, so it adds signing machinery without improving the trust prompt.
- **Per-machine NSIS (rejected)** — elevation is unnecessary for a developer tool that can install and update within one user's profile.
- **Assisted per-user NSIS (chosen)** — users can inspect and choose the installation directory without administrator access.

## Consequences

- GitHub Releases is the sole application distribution and update channel. `latest.yml` and the blockmap feed `electron-updater`; Electron installers are never published to npm.
- The preview is x64-only and must be described as unsigned. Documentation may explain Windows' supported **More info → Run anyway** flow but must never recommend disabling SmartScreen or Defender globally.
- Hashes and update metadata protect the downloaded bytes but do not establish publisher identity.
- Signing is deferred to a publicly trusted OV/EV certificate or Azure Trusted Signing. Once introduced, release verification must require the expected publisher identity.
