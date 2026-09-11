# omp-ui

omp-ui is a cross-platform desktop GUI for
[Oh My Pi](https://github.com/can1357/oh-my-pi), the `omp` coding agent.
It keeps registered projects and owned sessions in one place while providing
both native transcript tabs and terminal tabs for your coding work.

## What it gives you

- Open native transcript tabs for rendered markdown and
  tool calls, or use terminal tabs for the full OMP TUI
  with its familiar keybindings.

- Register projects, launch and resume owned sessions, and use worktree
  sessions when a task needs a dedicated checkout and branch.

- Prompt from the native composer, configure the advisor per session, and
  review or refine proposed plans before implementation begins.

- Follow todos and subagents in the inspector rail, inspect session details
  and proposed plans, and review project branch changes in Diffs.

- Turn on optional remote access to reach the same app and live sessions from
  a browser or phone.

- Let omp-ui install and update its managed `omp` binary, and supply provider
  keys to every `omp` process it launches.

- Install available omp-ui and managed `omp` updates from their in-app update
  cards.

## Install

### Linux

Install the supported Linux AppImage:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

### macOS preview

Download the signed and notarized DMG for your Mac from the
[latest release](https://github.com/LankfordAI/omp-ui/releases/latest): use
`arm64` for Apple Silicon or `x64` for Intel. Open the DMG and drag **omp-ui**
to **Applications**.

### Windows preview

Download the unsigned x64 `setup.exe` from the
[latest release](https://github.com/LankfordAI/omp-ui/releases/latest) and run
it. If SmartScreen warns about the unknown publisher, select **More info**,
then **Run anyway**. Do not disable SmartScreen or Defender.

See [Getting started](docs/getting-started.md) for checksums, platform details,
first launch, and uninstall instructions.

## Documentation

Start at the [documentation home](docs/README.md), or go straight to a
guide:

- [Getting started](docs/getting-started.md)
- [User guide](docs/user-guide.md)
- [Settings](docs/settings.md)
- [Remote access](docs/remote-access.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Releases](docs/releases.md)

## Development

Development requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

See the [development guide](docs/development.md) for the repository layout,
commands, testing, and contribution workflow.

## License

omp-ui is available under the [MIT License](LICENSE).
