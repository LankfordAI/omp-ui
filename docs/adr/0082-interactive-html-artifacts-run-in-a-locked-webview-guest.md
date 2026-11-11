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
- **Plain arguments are the artifact.** omp persists the tool call's
  `arguments` in the session JSONL, `get_messages` returns them, and
  `historyToItems` keeps them on the `ToolItem`. Plain documents replay from
  those arguments. Managed documents use the retained resolved payload described
  in [ADR-0090](0090-session-authored-artifact-library-and-scoped-data.md), not
  a fresh read of an authoring-time dataset file.

## Decision

1. **One essential host tool, called directly.**
   `omp-ui_render_html { title, html, height?, artifact? }` is registered on
   every rpc-ui spawn after `omp-ui_notify`
   ([ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md)). Main
   admits it only when the input-order assistant stream has already established
   the matching direct tool call. Wrapping it in `eval`, `task`,
   `multi_tool_use`, or `write xd://...` is refused rather than reporting an
   invisible render. Main validates a non-empty title of at most 200 characters,
   non-empty HTML of at most 512 KiB in UTF-8, and height clamped to 120–1200 px.
   A refused call returns an error with the reason. Plain calls need no retained
   state; managed calls stage their resolved document and data through ADR-0090.
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

## Amendment: render-only file-backed datasets (2026-11-09)

A managed render may declare each dataset with exactly one of inline `value`
or `valueFile`. `valueFile` names a UTF-8 JSON file under the owning session's
exact `local://` root. Main reads and validates it before staging the document,
then retains the resolved JSON value, not a live file link. This is an authoring
convenience for `omp-ui_render_html` only; capture tools still require inline
values. It gives neither the guest nor a browser client filesystem access.

Plain cards still replay from transcript arguments. Managed cards replay from
the retained resolved payload. A missing historical managed payload containing
`valueFile` is unavailable, never reconstructed from whatever bytes occupy that
path later. Existing orphan transcript rows are not deleted by the new admission
rule. The locked guest and human Keep/Apply boundaries are unchanged.

## Amendment — artifacts show with the run's final reply (2026-11-10, issue #1141)

A completed `omp-ui_render_html` call no longer shows at its call position. It
moves to directly before the first final reply after it within its segment,
the span between user items. A final reply is a non-streaming assistant
message with a recorded stop reason that is not a tool hop (`toolUse`,
`tool_use`, `tool_calls`), so stop, length, error and aborted all end a run.
With no such reply, the artifact holds its place as a one-line note while the
tab is running. Once the segment is settled, because a user item follows or
the tab stops running, it lands after the segment's last non-ambient item.
Running, errored and cancelled calls never move, and a placed artifact never
moves again.

The order is display-only. The renderer computes it in
`lib/artifact-placement.ts` over the full item list before windowing, and find
and the transcript share the result. The session file, HostBridge, export and
Keep are untouched. The tool description nudges the model to call it right
before its final reply, so most runs already show in call order.

Alternatives rejected:

- Render immediately at the exchange tail. Rows sit inside a Fragment keyed by
  the run key, the first item id in `buildRuns`. A tail artifact changes runs
  as items arrive, which remounts and reloads the guest nearly every tick.
- Group by exchange and hold on `turnActive`. That flag includes `busy`, which
  is true for any command, so idle model changes and startup would reload the
  chart. Holding to the exchange end also leaves it unplaced while the
  exchange is live.
- Group by agent started/finished markers. `historyToItems` emits no markers,
  so order would differ after reload.
- Place below the final reply. The prose usually refers to "the chart above",
  and runs that already call `omp-ui_render_html` last stay unchanged when it
  is placed above.
- Prompt nudge only. It gives no guarantee.
- Rewrite the session file order. The order is display-only; the stored
  transcript and model context keep the real call order.

## Amendment — guest lifecycle and focus reclaim (2026-11-11, issues #1130, #1152, #1148)

- **Escape reclaims native keyboard focus from every partition guest.** An
  out-of-process `<webview>` retains native keyboard focus even after the
  renderer collapses its overlay, and Electron's `WebContents` exposes no blur
  API — nothing host-side can drop it. Native focus for a guest rides on the
  host frame's focused `<webview>` element, so the broker (when forwarding a
  guest Escape notice) and the guard (on every attached artifact-partition
  guest — plain guests included, which have no broker surface) blur that
  element from the trusted root frame, then refocus the root; the order matters
  because Chromium restores focus to the last-focused element when a
  WebContents reactivates. The reclaim is proven across processes by the
  packaged smoke under a real display server; headless Ozone never arbitrates
  native focus, and there the check self-reports as skipped rather than
  asserting falsely. Nothing else crosses to plain guests: no preload, no
  `load()`, no `saveState()`. This is safe by construction because
  `before-input-event` observes real user input only; guest JavaScript cannot
  fabricate it.
- **Hidden tabs release their plain guests.** Every mounted card is a guest
  process; the app keeps background tabs mounted with `display:none`, so plain
  surfaces now mount only while the tab is visible, keeping a sized
  placeholder and the expand control otherwise. First mounts are deferred by
  a one-way IntersectionObserver latch (generous root margin, latches on and
  never off within the visible tab), and a plain expanded card mounts exactly
  one guest — the modal viewer — not inline surface plus modal.
- **Scroll-driven guest eviction stays rejected.** Teardown on scroll-out
  resets measured heights against follow-mode anchoring, burns single-use
  admission tickets and the root rate budget, and throws away interactive
  guest state that ADR-0090 never captures.
- **Plain guests get a trusted failure row.** `did-fail-load` and
  `render-process-gone` replace the frame with host-owned text plus Reload —
  the same posture as the static hint; no guest download or other capability
  is added.
- **The scripts-off pill span is the sole sanctioned exception to flush
  posture.** It appears only for a non-deferred plain card whose document
  actually contains script markup, as faint text in the existing hover pill
  row and the expanded viewer header. Script-free documents stay fully flush.
