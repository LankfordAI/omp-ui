# PDF attachments ride the prompt as a scratch-file path, not a wire field

omp's rpc protocol has no document field: the prompt frame carries text and
`images` only (ADR-0006), and omp-ui never adds fields to omp's frames. A PDF
therefore cannot ride the protocol the way an image does. The chosen shape:
the bytes ship over an omp-ui-owned channel to the machine that owns the
session, materialize as a scratch file, and the prompt text ends with an
`<attached documents>` block naming the absolute path — omp's `read` tool
converts PDFs to text from a path, so the path *is* the channel.

## Findings

- omp's `read` tool accepts a PDF path and returns its text; nothing in omp
  ingests raw PDF bytes over rpc.
- The rpc frame shape is fixed by omp (`prompt` carries `message` + `images`);
  ADR-0006 settled that omp-ui does not extend it, and upstream requests are
  out of bounds (AGENTS.md).
- Image attachments already established the scratch-file pattern for the
  terminal tab (`images.ts`, ADR-0006): write under `os.tmpdir()`, hand the
  path to the TUI, sweep on quit.
- A joined remote session's files must land on the *remote* machine —
  the same routing `ptyPasteImage` uses: tab-routed request channels reach
  the owning instance through the `REMOTE_PROXY_CHANNELS` allowlist.

## Decision

- `session:attachDocument` (batch) and `pty:pasteDocument` (single, terminal
  tab) are omp-ui backend channels carrying
  `DocumentAttachment = { type: "document", name, mimeType, data? | path? }`.
  Both are tab-routed, so a joined remote materializes on the remote host.
- The renderer never writes the scratch file. `resolveDocument` (core) either
  writes `data` to `os.tmpdir()/omp-ui-attach/<uuid>.pdf` or verifies an
  existing `path` — the XOR is a caller-contract check, not input validation.
  A uuid name, never the display name: two documents sharing a name must not
  collide (same reasoning as `writeImageToScratch`).
- The composed prompt is `prose + resolved-file blocks + documents block +
  image routing suffix`. The transcript derivation strips the routing suffix,
  then the documents block, then the file blocks — the mention splitter
  anchors its close at end-of-text, so the document block must already be
  gone or a steer message's file block would never parse as terminal.
- Rewind and plan-refine re-attach by path: the prefill carries
  `{ name, path }` and the draft shows the chip without bytes. No re-upload;
  if the scratch sweep removed the file, the send fails with
  `document not found: <path>` and the draft survives for re-pick.
- Materialization happens in the component (`Composer.submit`,
  `PlanReview.refine`) *before* the draft is committed, so a rejection keeps
  text, images, and documents intact — the keep-draft shape of the worktree
  conversion.
- Per-file ceiling 20 MB (mirrors the image UX ceiling); per-request
  base64-budget 48 MB so a batch fits under the remote WS transport's 64 MiB
  client-frame cap with JSON framing headroom.

## Consequences

- A document's transcript chip is reconstructible only from the prompt text
  itself; the block is omp-ui-authored prose, so `splitDocumentContext` is
  parse-shaped (malformed lines pass through untouched, exactly like the
  resolved-mention splitter).
- The scratch dir lives in the OS temp dir and is swept on quit next to the
  image dir; a crashed app leaves files for the OS to reap, same trade as
  images.
- Renaming the composer's paperclip to "attach files" touches the shared
  `common.button.attachImages` key: it becomes `common.button.attachFiles`
  in both locales, and `terminal.tab.attachImages` follows.
