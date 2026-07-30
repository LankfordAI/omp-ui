# Pasted images: inline bytes for rpc-ui, a scratch file for the PTY

Pasting (or dropping) an image attaches it to the prompt in both modes. The two
modes use different transports because they have different capabilities, not
because of a UI preference.

## rpc-ui — inline base64 on the prompt frame

`prompt`, `steer`, `follow_up`, and `abort_and_prompt` each accept
`images?: ImageContent[]` (`src/modes/rpc/rpc-types.ts:33-37`), where
`ImageContent` is `{ type: "image", data: <bare base64>, mimeType }` — no
`data:` URL prefix, since omp feeds `data` straight to `Buffer.from`. There is
no `attachments`/`files`/`{ path }` variant, and `@file` args are rejected
outright in rpc mode (`src/main.ts:1169`).

**The 1 MiB `maxFrameBytes` in the `ready` frame is outbound-only.** omp's stdin
loop is a plain `readLines` + `JSON.parse` with no size check
(`rpc-mode.ts:1475-1487`), and `readLines` has no cap. So an image goes as one
JSON line, however large. It must **not** be chunked: `rpc_chunk` is an
outbound-only frame and an inbound one parses as an unknown command.

## PTY — a scratch file plus a bracketed paste

The PTY carries no byte channel, so the bytes are written to
`$TMPDIR/omp-ui-paste/<uuid>.<ext>` and the *path* is delivered as a bracketed
paste (`\x1b[200~<path>\x1b[201~`). omp's TUI editor scans bracketed-paste
content for a single explicit path with an image extension and loads the file
itself (`extractBracketedImagePastePath`, `src/modes/components/custom-editor.ts`).

Verified by running omp's own extractor over omp-ui's payload, and by calling
omp's `loadImageInput` on the file omp-ui wrote.

- **One path per paste.** omp refuses a payload carrying two path anchors —
  `/tmp/a.png /tmp/b.png` attaches nothing — so a multi-image paste is delivered
  as separate bracketed pastes.
- **The extension must be one omp recognises** (`.png`/`.jpg`/`.jpeg`/`.gif`/
  `.webp`), or the payload degrades to literal text in the prompt. An unknown
  mime type is written as `.png`, the format omp itself converts to.
- **Names are fresh uuids, never the clipboard's.** omp reads the file *after*
  the paste is delivered, so a reused path would attach the wrong image.
- The scratch dir is swept on quit; it is one directory, so a crash leaves
  something sweepable rather than files scattered through `$TMPDIR`.

An alternative was omp's OSC 5522 enhanced-clipboard protocol
(`src/utils/enhanced-paste.ts`), which omp enables with `\x1b[?5522h`. That
would require omp-ui to implement the *terminal* half of the protocol —
answering `type=read` requests with chunked DATA packets — for no gain over
handing over a path.

## Shared decisions

- **omp-ui does no image decoding.** It forwards the clipboard's bytes and lets
  omp normalize: omp accepts four mime types and re-encodes anything else via
  `Bun.Image`, so a format omp would accept is never rejected here for want of
  a codec.
- **omp's 20 MB `MAX_IMAGE_INPUT_BYTES` is enforced by omp-ui**, because omp
  does *not* apply it to the rpc `images` field. Without the check a 200 MB
  paste becomes a ~270 MB JSON line on omp's stdin.
- **Text pastes are untouched** in both modes. Only a paste carrying an image
  file is intercepted; a clipboard with both still pastes its text.
- **The mime type does not round-trip.** `normalizeModelContextImages` re-encodes
  on ingest, so a pasted PNG comes back from the transcript as `image/webp`.
  Render items therefore carry omp's mime type, not the clipboard's.
- **Vision support is gated on `model.input` containing `"image"`** — the only
  capability probe the protocol offers. A model without it makes the composer
  say so rather than dropping the images silently.
