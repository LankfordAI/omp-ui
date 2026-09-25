# Dictation is captured in the renderer's memory and transcribed in the main process

> **Status:** Accepted, 2026-09-24 ([#647](https://github.com/LankfordAI/omp-ui/issues/647)).

Composer dictation (issue #647) needs three things decided together: where
audio is captured, where it is transcribed, and which model list picks the
transcriber. Each had a tempting wrong answer this ADR records against.

## Decision

- **The renderer captures, in pure typed-array memory.** `getUserMedia` +
  Web Audio `ScriptProcessorNode` → Float32 chunks → linear resample to
  16 kHz → a hand-written RIFF/WAVE header into one `DataView` → base64.
  `MediaRecorder` and `Blob` are deliberately absent: reading a recorded Blob
  back throws `NotReadableError` under this app's Electron 43 sandbox —
  Chromium's blob I/O needs shm mappings the harness blocks (verified on this
  machine; the pure-memory path produced a clean 68 KB WAV for 2.5 s that
  transcribed correctly). `ScriptProcessorNode` is deprecated but is the only
  pure-memory tap that needs no AudioWorklet module URL — a module URL would
  be a Blob URL, the same blocked path. Muted-`GainNode` wiring pulls audio
  without feedback; teardown runs on every path (stop, cancel, error, unmount)
  so the device LED never outlives the take.
- **The main process transcribes, with the app-resolved credential.** The
  renderer posts a `stt:transcribe` request carrying bare base64; main posts
  one multipart `fetch` to the provider's OpenAI-compatible
  `/audio/transcriptions` using the key `ProviderKeys.applyToProcessEnv`
  installed into `process.env` (stored, inherited environment, or login-shell
  capture — the same credential the app already hands every spawned omp). The
  renderer never sees a key. A 65 s abort sits just past the providers' own
  60 s upstream cap; 429s surface verbatim with no retry — a retry loop would
  silently re-bill paid audio.
- **The model list is discovered from omp's STT catalog.** `omp models --kind
  stt --json` is the only source (ADR-0027 rule: never curated in omp-ui).
  The probe runs under the **live** `process.env`, not a pristine one — the
  catalog is key-gated (verified v18.2.11: `openai` rows appear only with
  `OPENAI_API_KEY`), and the key omp-ui calls with is the one already applied.
  Rows whose provider omp-ui cannot route (`STT_ROUTES`) render pressed-but-
  labelled when stored, disabled when not. A stored selector missing from a
  newer omp's catalog stays callable: routes derive from the selector itself
  (ADR-0027 precedent).
- **omp's `local/*` models are excluded.** They run in-process inside omp via
  sherpa-onnx — no HTTP endpoint exists for omp-ui to post to. That is a
  TUI-only path, and ADR-0007 already taught us not to route through omp's
  TUI machinery.
- **omp's own dictation is not the mechanism.** `stt.enabled` / hold-Space
  belongs to omp's TUI editor and an already-bound model role; neither exists
  for the native transcript composer. Reusing it would mean driving the PTY,
  which is exactly what the rpc-ui session mode moved away from.
- **The transcript is inserted at the caret, never submitted.** Dictation
  composes with every existing submit route (prompt, steer, queue, interrupt)
  unchanged; a running agent is irrelevant to capture. Escape while recording
  cancels the take before it means "abort the turn". The button self-hides
  when the global Voice input setting is off or the context cannot capture —
  a remote web client on a LAN IP is a non-secure context with no
  `getUserMedia`, and a dead affordance is worse than none. No renderer
  permission plumbing is needed: with no `setPermissionRequestHandler` on the
  default session (deny-all lives only on the browser-pane and plan-verifier
  partitions), `getUserMedia` resolves; enabling the setting is the consent.

## Consequences

- The 60 s cap and the ½ s empty guard bound the base64 payload to ~2.6 MB —
  inside both Electron's structured-clone IPC and the remote client's 64 MB
  JSON frame cap, so no binary transport is needed.
- Two global settings (`voiceInputEnabled`, `sttModel`) ride the normal
  registry broadcast; the picker probes once per Settings-General mount like
  the web-search list, never cached.
