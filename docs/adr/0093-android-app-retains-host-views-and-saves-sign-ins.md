# Android app retains host views and saves sign-ins

> **Status:** Accepted, 2026-11-13 ([#1167](https://github.com/LankfordAI/omp-ui/issues/1167)). Amends [ADR-0028](0028-remote-instances-joined-by-main-process-proxy.md) (only the derived credential is kept; the password is never stored) for the Android app only.

The Android app ([architecture](../architecture.md#android-client)) held one WebView for one host. Switching hosts meant typing an address into the native connection panel, confirming that the current view would be replaced, and then waiting for a cold page load — and signing in again whenever the host's session cookie had expired or the user had cleared local data. People who move between two or three omp-ui hosts in a day paid that cost every time.

## Decision

**1. One WebView per visited host, at most four live.** Each host the user connects to keeps its own retained WebView; switching hides the current one and shows the target's, so drafts, scroll, and live tabs survive the switch. When a fifth host is opened, the least recently shown view is destroyed; returning to it reloads its sanitized origin. Only the visible view carries the active-view identity (`R.id.remote_webview`), and native callbacks (color channel, Back, viewport) act only for the current view. This is safe because each view keeps its own exact-origin policy: its navigation guard, document-start script, and `__ompAndroidChrome` listener are bound to that view's origin alone, so no host can reach another's view. The WebView renderer process is shared, so a renderer crash takes down every retained view; the shell then reloads all of them rather than restoring DOM.

**2. Saved hosts, at most sixteen.** After a host's first successful page load the app saves its origin with an editable name. Saved hosts appear in the connection panel and in a native switch sheet. The sheet opens from the existing Android-only **Host connection…** link (`omp-ui://host-connection`) instead of a host-page menu: the host page never sees the list of other hosts, and no new document-to-native channel is added.

**3. Saved sign-ins in Keystore.** For each saved host the app may keep one password or pairing token, encrypted with an Android Keystore AES-GCM key (alias `omp-ui-saved-sign-ins`) using the host origin as associated data, so a ciphertext copied under another origin fails to decrypt. Stored values use a versioned `v1:` format; anything else is discarded. The key requires no user-authentication unlock prompt: the threat model is another app or a copied backup, not someone holding the unlocked phone.

**4. Native, cookieless verification.** Native code checks a sign-in directly against the host with `HttpURLConnection`, sending no cookie and following no redirect: a password via `POST /login`, a pairing token via `GET /healthz?t=`. An accepted answer's `omp_ui_token` cookie is copied into the WebView cookie jar. A typed password is saved only when the host accepts it; a pairing token is saved only after the host serves a non-login page for it. A throttled (429) or unreachable answer saves nothing and deletes nothing.

**5. Automatic sign-in once per view.** When a saved host's view lands on `/login`, or a token-only host answers 401, the app uses the saved sign-in once for that view. A rejected saved sign-in is forgotten and the user is asked again; a throttled or unreachable answer keeps it. Because the attempt is tracked per view, a wrong password typed into the host's own form never loops.

**6. Remove vs Clear.** **Remove** on a saved host deletes its entry and its saved sign-in and closes its hidden view; the visible view stays connected but leaves the list. Its cookie and origin-local recovery stay, because they are global to the app's WebView profile. **Clear saved hosts and sign-ins** is the existing all-host removal, extended to delete every saved host, every saved sign-in, and the Keystore key.

## Amendment to ADR-0028

ADR-0028 keeps only a derived credential for desktop joins and never stores the password. The Android app, unlike those desktop joins, stores the password (or pairing token) itself: the user wants sign-in to survive both cookie expiry and the all-host local-data clear, and a derived session cookie survives neither. The stored secret is encrypted at rest with a non-exportable Keystore key, bound to its origin, never logged, and never exposed to any host page.

## Consequences

- Switching between up to four recently used hosts is warm; a fifth reloads.
- A renderer crash reloads every retained view.
- A saved password is recoverable by anyone who can run code as the app on an unlocked device; this is accepted for convenience.
- The host page gains no new API: the sheet, the list, and the sign-ins are native-only.
