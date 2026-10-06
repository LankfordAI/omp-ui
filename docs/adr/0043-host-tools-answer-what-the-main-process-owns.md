# Host tools and the `omp-ui://` scheme answer from the main process

Resolves issue #688. Verified against omp 18.4.3.

## Findings

- omp's rpc-ui protocol lets the RPC peer (here: omp-ui) register tools and
  internal-URL schemes — `set_host_tools` and `set_host_uri_schemes` commands,
  inbound `host_tool_call` / `host_uri_request` frames, and their
  `*_cancel` siblings. omp answers-reads `omp-ui://…` and friends through the
  same `InternalUrlRouter` the built-in `omp://` / `artifact://` schemes use
  (`internal-urls/router.ts`), so a host scheme behaves like a built-in one
  inside every tool that resolves an internal URL (`read`, `grep`, `glob`, …).
- omp's guard `isRpcHostToolResult` accepts a success result only when it
  carries `result.content` as an array; the previous renderer stub's
  `{id, error}` shape was silently dropped, hanging the agent's tool call
  until abort or stdin EOF. A scheme name must match `^[a-z][a-z0-9+.-]*$` and
  must not collide with a reserved built-in (`omp agent artifact memory local
  skill rule mcp issue pr history ssh xd vault`); a tool-name collision
  rejects the WHOLE `set_host_tools` command, which is why the one tool is
  namespaced `omp-ui_notify`.
- A host result for an id omp has already abandoned (timed out or cancelled)
  is dropped silently — an answerer racing a cancel is harmless, which makes
  a watchdog safe as the never-hang guarantee.
- omp's `InternalResource.contentType` union is
  `text/markdown | application/json | text/plain`: an HTML plan read through
  `omp-ui://plan` carries its markup as `text/markdown`.

## Decision

1. **Main answers host frames, never the renderer.** The process owner —
   SessionManager's RpcClient — registers both bridges on every rpc-ui spawn
   (`set_host_uri_schemes` + `set_host_tools` ride `initialCommands`, so they
   land before the first turn on fresh spawn and resume alike) and routes
   every inbound host frame through `HostBridge` on the client's input-order
   seam (`onInputFrame`, before the ready interception and before
   forwarding). The renderer keeps only a fallback error-result stub; the
   frames it no longer answers (`host_tool_call`, `host_uri_request`) and the
   cancels it must swallow are fenced in `rpcSend` by the id set the bridge
   records synchronously when it takes a request.
2. **Why main, not the renderer.** The two host features are app state the
   renderer does not own. `omp-ui://plan` resolves against the same validated
   bytes the review gate shows — main's preflight snapshot (§5.4) or the
   confined lineage-dir reader — and the plan path itself is captured from
   the frame edge before the preflight can claim it. `omp-ui_notify` posts an
   OS notification, which only main can do. Answering in the renderer would
   re-route both through IPC to the process that already owns them, and would
   put a second answerer behind the single fence; answering in main keeps one
   owner, one pending map, and one watchdog per process.
3. **One result, exactly, by construction.** Taking a request marks its id
   answered synchronously (renderer fence), arms a 60 s watchdog answering a
   generic error (omp arms no host-tool timer of its own, so this watchdog is the never-hang guarantee; see ADR-0048), and moves the id out of the pending map the instant any
   answerer takes it — real answer, cancel, or watchdog are mutually
   exclusive. Cancels are never answered: omp already stopped waiting, and
   omp drops a result for an abandoned id anyway. A killed spawn is fenced by
   the same identity check every other capture uses, and `forget` drops the
   tab's whole state on exit.
4. **Read-only scheme, one resource.** `omp-ui://plan` is registered
   `writable: false, immutable: true`: a model that could write the plan file
   would break the preflight's `sourceHash` integrity gate, and `immutable`
   tells omp's router the resource never needs cache-busting. `plan` is the
   only resource — the plan the session last proposed — and a session change
   (the roster-retirement trigger of #374) clears it so a switched-into
   session is never served the predecessor's plan. Reads prefer the validated
   snapshot while an HTML gate holds the plan; otherwise they go through the
   confined plan reader (realpath containment, regular-file check, byte cap)
   rooted at the tab's lineage dir — the same reader as `plan:read`, so model
   and review pane can never disagree about which bytes they read.
5. **Notify bypasses the attention pipeline.** The #271 notifier exists to
   interrupt *without* spamming: delayed 3 s, dropped when activity or the
   user's attention says otherwise. A `notify` call is an *explicit* model
   request to interrupt, so it posts through the new `notifyNow` entry: only
   the Settings switch and platform support gate it, click still focuses the
   session, and the tool result reports whether the desktop actually showed
   it. The title defaults to the sidebar session title.

## Consequences

- The `omp-ui_notify` tool and `omp-ui://plan` scheme exist in every rpc-ui
  session from its first turn; PTY-embedded sessions have neither (the RPC
  peer there is the terminal, not omp-ui), which matches the out-of-scope
  rule that remote-instance tabs keep the renderer stub path.
- `frame-reduction`'s host-frame stubs now answer well-formed error results
  (correct shape; visible only when main did not answer first), and the
  cancel frames settle silently instead of falling into the agent-event
  reducer.
- A stuck answerer is bounded: the watchdog's answer is generic and carries
  the request id, so a late real answer is impossible (the pending entry is
  gone) and the model is told the truth — omp-ui could not answer in time.
