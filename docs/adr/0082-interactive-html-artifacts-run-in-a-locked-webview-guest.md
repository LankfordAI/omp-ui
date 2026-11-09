# Interactive HTML artifacts run in a locked webview guest

> **Status:** Accepted, 2026-10-30 ([#994](https://github.com/LankfordAI/omp-ui/issues/994)). Verified against omp 18.14.0 and Electron 43.2.0.

An agent shows the user a self-contained interactive document (a chart, a
sortable table, a small simulator) inline in the native transcript by calling
the `omp-ui_render_html` host tool. This is a separate surface from HTML
plans: plan frames stay script-free ([ADR-0014](0014-html-plans-authored-directly.md),
[ADR-0020](0020-mermaid-diagrams-in-html-plans.md), [ADR-0022](0022-prepared-plan-verification-in-the-renderer.md))
and nothing here changes them. The document is agent-authored and may be
prompt-injected through tool output, so this ADR records its threat model.

## Findings

- **The issue's iframe+CSP sandbox leaks over WebRTC.** In omp-ui's own
  renderer (headless, over CDP), an `<iframe sandbox="allow-scripts">`
  without `allow-same-origin`, wrapping a `default-src 'none'` CSP, gets an
  opaque `null` origin in its own process and is refused `parent.document`,
  `window.ompBackend`, `localStorage`, `fetch`, `WebSocket`, `sendBeacon`,
  `EventSource`, external `img-src`, popups, and form submission. But
  `new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:3479"}]})` still
  sent STUN binding requests to a UDP listener on that port. No CSP directive
  gates WebRTC (`webrtc 'block'` is reported "Unrecognized"), and deleting the
  constructor does not hold: a nested `srcdoc` iframe hands back a fresh realm
  even under the artifact's own `frame-src 'none'`.
- **Out-of-process frames bound CPU burn.** An artifact spinning `for(;;)`
  left the main renderer answering CDP evaluation in 1 ms.
- **omp records an essential host tool under its own name.** omp 18.14.0's
  `RpcHostTool` takes `loadMode` from the definition, or `discoverable` for
  any name outside its essential set (`tools/essential-tools.ts`). A
  discoverable tool is reached with `write xd://<tool>`, which the session
  file records as a `write` call, so a card keyed on the tool name would never
  render. Essential tools appear as `toolCall { name, arguments }` and
  `toolResult { toolName }`.
- **The arguments are the artifact.** omp persists the tool call's
  `arguments` in the session JSONL, `get_messages` returns them, and
  `historyToItems` keeps them on the `ToolItem`. A reload or a joined viewer
  re-renders the card from the transcript with nothing stored host-side.

## Decision

1. **One essential host tool.** `omp-ui_render_html { title, html, height? }`
   is registered on every rpc-ui spawn after `omp-ui_notify`
   ([ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md)). Main
   validates the arguments (non-empty title of at most 200 characters,
   non-empty html of at most 512 KiB in UTF-8, height clamped to 120–1200 px)
   and answers at once. A refused call is an error result with the reason, and
   the card shows that reason instead of a document. Main keeps no state.
2. **Desktop runs the document in a `<webview>` guest on a locked partition.**
   `omp-ui-artifacts` is in-memory. `html-artifact-guard.ts` sets it up once:
   - It uses a fixed proxy at the discard port, with `<-loopback>` so loopback
     goes through the proxy too.
   - A `webRequest` filter cancels anything that is not `data:`, `blob:`, or
     `about:`.
   - Every permission, device, display-media, and download request is denied.
   - Every guest gets WebRTC policy `disable_non_proxied_udp`, which forbids
     UDP that cannot ride the dead proxy. Guests also deny window opening,
     navigation, and redirects off their document.
   - `will-attach-webview` admits only this partition with a data/blob/about
     `src`, and only after the proxy is in force. It overwrites the guest's
     preferences: no preload, node, nested webviews, or dialogs, and sandboxed
     with context isolation.

   The window enables `webviewTag` for this use only; the guard is the only
   way a guest can attach.
3. **The document's own policy still applies.** `composeHtmlArtifactDocument`
   puts a `<meta>` CSP first in the head, ahead of the author's bytes:
   inline script and style only, `data:`/`blob:` images, fonts and media, no
   connect, frame, worker, object, form, or base. Theme tokens follow as
   `:root` custom properties and `color-scheme`.
4. **Static fallback.** When **Run scripts in HTML artifacts** is off, the card
   shows the same document in a plan-style frame: an empty `sandbox` with
   `script-src 'none'`. A browser client (remote access) always gets the
   static frame, because it has no partition omp-ui controls and the WebRTC
   hole would come back.
5. **No browser-pane hand-off.** The browser pane is a full browser with
   network and agent CDP access, and its #531 guards admit only `http`/`https`
   at the top level. The card offers taller/shorter and an expand-to-full-view
   modal using the same guest instead.

## Consequences

- A prompt-injected artifact can draw, compute, and respond to clicks. It
  cannot reach the network, the host's IPC, the parent DOM, storage, devices,
  or new windows, and its CPU use stays in its own process.
- A joined remote-instance viewer renders the card with its own setting and
  sandbox, from arguments that arrived as transcript content. Nothing executes
  on the owning host. `htmlArtifactResultText` does not mention the setting,
  because the owner answering the call is not the machine displaying it.
- Every artifact costs a guest process while its card is mounted. The bounded
  transcript tail window ([ADR-0057](0057-native-transcript-renders-a-bounded-tail-window.md))
  unmounts older rows, which bounds how many run at once.
- Electron's guidance prefers iframes to `<webview>`. omp-ui accepts the tag
  because an iframe gives no session-level network control, and the attach
  guard removes the tag's usual risk: a renderer minting an arbitrary guest.

## Amendment — artifacts size to their own content (2026-11, issue #1041)

The card's chrome (title bar, taller/shorter controls) is gone: the artifact
renders flush in the transcript column and sizes to its own document. The
height channel rides a same-document address rewrite. The injected guest
script calls `history.replaceState` with `#omph<px>` and its measured content
height — deliberately not a `location.hash` write, which is a fragment
navigation the confinement guard's `will-navigate` cancels (verified live on
this Electron). A replace of the fragment crosses no origin, issues no
request, and trips no navigation handler, yet Chromium still surfaces it to
the host as a `did-navigate-in-page` event, without loosening any boundary. The host parses
the reported height only from that prefix, ignores anything else, and clamps
it to [`HTML_ARTIFACT_MIN_HEIGHT`, `HTML_ARTIFACT_MAX_HEIGHT`]; the agent's
requested height stays the initial hint and the static fallback, which is the
only height a scripts-off or browser-client view can have. The guest boundary
is unchanged: same partition, same request filter, same CSP.

## Amendment — scoped managed state, default-off (2026-11-09, issue #1121)

[ADR-0090](0090-session-authored-artifact-library-and-scoped-data.md) permits
one narrow exception to the no-preload rule: a script-enabled managed artifact
whose exact document and single-use ticket were issued by main may receive the
self-contained `artifact-runtime.js` preload. Hello binds the actual guest/root
main frame, locked session, document, owner and gate epoch. Only load and CAS
manual-state patching are exposed; human Keep/accept/Apply/delete, raw IPC,
Node, files, credentials, networking and session tools are absent.

Every other boundary in this ADR remains, including dead-proxy loopback and
WebRTC denial. Plain documents still receive no preload. Scripts-off and browser
documents stay static; HTML plan frames remain script-free. Saved structured
data belongs to a separate app-registry-owned SQLite library, not DOM storage
or arbitrary JavaScript closures, and turning the experiment off revokes access
without deleting it.

