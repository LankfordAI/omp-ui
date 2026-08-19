# Documentation

This documentation covers installing, using, configuring, troubleshooting, developing, and releasing omp-ui. For the project overview and feature summary, return to the [root README](../README.md).

## Choose a reading path

- **First-time user.** Start with [Getting started](getting-started.md), then use the [User guide](user-guide.md) to learn the daily session workflow. Open [Settings](settings.md) when you need to change defaults or credentials.
- **Daily user.** Keep the [User guide](user-guide.md) as the main operating reference. Use [Settings](settings.md) for app preferences and [Troubleshooting](troubleshooting.md) when expected behavior breaks.
- **Remote user.** Follow [Remote access](remote-access.md) to expose and secure the browser client, then read the [User guide](user-guide.md) for the session controls shared with the desktop app. Use [Troubleshooting](troubleshooting.md) for connection problems.
- **Contributor.** Read [Development](development.md) for the local workflow, [Architecture](architecture.md) for package boundaries and runtime flow, and the [contributor vocabulary](../CONTEXT.md) before naming concepts in code, issues, or commits. Consult the [architecture decision records](adr/) for the reasons behind established constraints.
- **Release maintainer.** Start with [Releases](releases.md), then use [Development](development.md) for build commands and the [release-related decision records](adr/) for platform policy and packaging constraints.

## Task guides

- [Getting started](getting-started.md) installs the supported Linux AppImage and walks through the first project and session.
- [User guide](user-guide.md) explains projects, owned sessions, tabs, session controls, plan review, worktree sessions, and the inspector rail.
- [Settings](settings.md) covers app preferences, provider credentials, the managed omp binary, memory, themes, and session defaults.
- [Remote access](remote-access.md) configures the browser client, authentication, network binding, and HTTPS expectations.
- [Troubleshooting](troubleshooting.md) provides symptom-based checks for installation, startup, sessions, providers, updates, and remote access.
- [Architecture](architecture.md) describes the core, desktop, server, and renderer boundaries and their data flow.
- [Development](development.md) covers prerequisites, local commands, repository conventions, and validation workflows.
- [Releases](releases.md) documents versioning, packaging, verification, signing, and publication for supported and preview platforms.

## Reference

- [Session encoding](session-encoding.md) defines how omp session identifiers, transcript paths, lineage directories, and related artifacts map to one another.
- [Contributor vocabulary](../CONTEXT.md) defines the project's domain terms and Avoid lists. It is a naming reference for contributors, not a user onboarding guide.

## Design records and implementation history

[Architecture decision records](adr/) explain durable product and architecture decisions, the alternatives considered, and the consequences of each choice. The phase documents record protocol contracts and implementation history for the staged integrations. Read an ADR when you need to understand why a constraint exists; read a phase document when you need the integration details and historical implementation plan. Current source code takes precedence over old implementation prose.

- [Phase 1: PTY embed](phase-1-pty-embed.md) records the terminal-tab architecture and PTY integration plan.
- [Phase 2: RPC UI](phase-2-rpc-ui.md) records the native transcript protocol, renderer behavior, and implementation plan.
- [Phase 3: ACP](phase-3-acp.md) records the Agent Client Protocol investigation and integration position.
- [AppImage-only Linux distribution research](research/appimage-only-linux-distribution.md) preserves the evidence behind the supported Linux packaging decision.
