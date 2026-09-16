<!-- PROTOTYPE (#526) — throwaway; not product code. -->

# Prototype: single-target CDP bridge over an offscreen WebContents (#526)

Answers one question for the browser-pane map (#521): can omp's agent drive a
page that omp-ui owns through a loopback CDP bridge, while the user side
consumes JPEG frames and pushes input?

Nothing here is product code. No dependency is added to the repo:
`puppeteer-core` lives in a scratch prefix outside the tree. All artefacts land
in `out/` next to this file (gitignored).

## Files

| File | Purpose |
| --- | --- |
| `main.cjs` | Electron main: offscreen window, test-page server, CDP bridge (`/json/version`, `/<token>/json/version`, WebSocket on `/<token>`), frame writer, input self-test |
| `client-puppeteer.cjs` | Part (a): puppeteer-core 25.3.0 client using omp's connect options |
| `test-page.html` | The "local dev server" page both clients and the input self-test act on |
| `omp-prompt.txt` | Part (b): prompt handed to omp; placeholders filled by the runbook |
| `out/summary.json` | Final numbers (platform, bridge counters, per-client method tallies, frame stats, input steps) |
| `out/cdp-traffic.jsonl` | Every frame between every client and the bridge plus every Electron debugger event/command |
| `out/frames/NNNN.jpg` | JPEG frames from `paint` |
| `out/puppeteer-run.json` | Part (a) step results; `out/puppeteer-shot.png` its screenshot |
| `out/omp-run.jsonl` | Part (b) omp `--mode json` stdout |

## Flags for `main.cjs`

`--size=WxH` (1280x800) · `--dsf=N` (offscreen deviceScaleFactor) · `--fps=N` (30) ·
`--frames=N|all` (60 JPEGs written; stats kept for all) · `--software` ·
`--url=http://…` (external dev server; DOM assertions skipped) · `--anim`
(animated box for sustained fps) · `--out=DIR` · `--no-input-test`.

Chromium switches pass through: append `--no-sandbox` if the sandbox refuses to
start, `--ozone-platform=x11` to see `--dsf=2` honoured on Wayland.

## Runbook

All commands from the repo root. Three terminals: **A** bridge, **B** puppeteer
client, **C** omp. Keep A running across B and C so one `summary.json` covers
everything.

### Linux and macOS

```bash
# one-time: puppeteer-core in a scratch prefix, never in the repo
export SPIKE_DEPS=/tmp/omp-ui-526
mkdir -p "$SPIKE_DEPS" && npm install --prefix "$SPIKE_DEPS" --no-package-lock puppeteer-core@25.3.0

# A — bridge (prints: READY cdp_url=… dev_url=… out=…)
npx electron packages/desktop/scripts/prototype-cdp-bridge-526/main.cjs
#   variants for the numbers: --dsf=2 ; --software ; --anim --fps=60 ; --size=1920x1080

# B — part (a); paste cdp_url and dev_url from the READY line
export CDP_URL=… DEV_URL=…
node packages/desktop/scripts/prototype-cdp-bridge-526/client-puppeteer.cjs "$CDP_URL" "$DEV_URL" packages/desktop/scripts/prototype-cdp-bridge-526/out

# C — part (b); scratch cwd so omp's discovery finds nothing of the repo
mkdir -p /tmp/omp-ui-526/cwd
sed -e "s#__CDP_URL__#$CDP_URL#" -e "s#__DEV_URL__#$DEV_URL#" packages/desktop/scripts/prototype-cdp-bridge-526/omp-prompt.txt > /tmp/omp-ui-526/prompt.txt
omp -p --mode json --tools eval --auto-approve --no-session --no-extensions --no-skills --no-rules --max-time 5m \
  --cwd /tmp/omp-ui-526/cwd "$(cat /tmp/omp-ui-526/prompt.txt)" | tee packages/desktop/scripts/prototype-cdp-bridge-526/out/omp-run.jsonl
#   if the model refuses ("cyber"), rerun with --model claude-haiku-4-5 and record that in the resolution
jq -c 'select(.type=="tool_execution_end") | .result.content | map(.type)' packages/desktop/scripts/prototype-cdp-bridge-526/out/omp-run.jsonl

# A — finish: type q + Enter in terminal A; summary.json is written
```

Note on the prompt: omp 18.1.21's `tab.click(selector)` (puppeteer Locator
path) hangs until its 8 s timeout in `app.cdp_url` mode against this bridge,
against Electron's own `--remote-debugging-port`, **and** against headless
Google Chrome, without sending any CDP command — an omp-side defect, not a
bridge one. `omp-prompt.txt` therefore clicks through the raw puppeteer path
(`tab.run("await page.click('#btn')")`); `tab.type`, `tab.run`,
`tab.screenshot` are omp's own helpers and work. Keep the three control runs
(`out/omp-run-tabclick-*.jsonl`) if you rerun the original `tab.click` variant.

### Windows (PowerShell)

```text
$env:SPIKE_DEPS = "$env:TEMP\omp-ui-526"
New-Item -ItemType Directory -Force $env:SPIKE_DEPS | Out-Null
npm install --prefix $env:SPIKE_DEPS --no-package-lock puppeteer-core@25.3.0

# A
npx electron packages\desktop\scripts\prototype-cdp-bridge-526\main.cjs

# B
node packages\desktop\scripts\prototype-cdp-bridge-526\client-puppeteer.cjs $CDP_URL $DEV_URL packages\desktop\scripts\prototype-cdp-bridge-526\out

# C
New-Item -ItemType Directory -Force "$env:TEMP\omp-ui-526\cwd" | Out-Null
(Get-Content packages\desktop\scripts\prototype-cdp-bridge-526\omp-prompt.txt -Raw) -replace "__CDP_URL__", $CDP_URL -replace "__DEV_URL__", $DEV_URL | Set-Content "$env:TEMP\omp-ui-526\prompt.txt"
omp -p --mode json --tools eval --auto-approve --no-session --no-extensions --no-skills --no-rules --max-time 5m --cwd "$env:TEMP\omp-ui-526\cwd" (Get-Content "$env:TEMP\omp-ui-526\prompt.txt" -Raw) | Tee-Object packages\desktop\scripts\prototype-cdp-bridge-526\out\omp-run.jsonl
```

### Optional: a real rpc-ui session

With terminal A still running: `npm run dev`, open an rpc-ui tab in omp-ui,
paste the filled prompt from `/tmp/omp-ui-526/prompt.txt` into the composer.
The traffic log gains another pair of sockets with the same method set.

## What to read off `out/summary.json`

- `bridge.rootPathHits` vs `tokenPathHits`: puppeteer fetches root
  `/json/version` (drops the token path); omp's own poll hits the token path.
  `tokenToRootGapMs` is the gap between the two.
- `clients[].rootIntercepted` / `rootForwarded` / `sessionForwarded` /
  `errors`: which CDP calls the shim had to fake versus pass through.
- `clients[].createTargetCalls`, `closeTargetCalls`, `browserCloseCalls`: how
  often a client tried to create/close targets (omp: expected 0).
- `frames`: encode time, inter-frame gap, JPEG bytes, dirty fraction,
  `idlePaintsIn3s` (0 without `--anim`), `sizeChangedAfterSetViewport`.
- `inputTest[]`: each step's `ok`, `latencyMs` (input call → next `paint`),
  and `winFocused` — on macOS/Windows this tells whether an unfocused hidden
  window still receives input.
- `window.dprReported` vs `dsfRequested`: Wayland ignores the offscreen
  deviceScaleFactor; X11 honours it.
