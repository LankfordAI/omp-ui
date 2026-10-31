# host-lite credentials

Credential sealing for the headless `lite` fleet member (issue #1010). A lite
box runs unattended: no window, no guaranteed OS keychain, possibly no D-Bus
session bus. This module therefore assumes nothing about the OS credential
store and fails toward a file it controls.

## Protector priority

`openLiteKeyCipherFor({ dataDir })` picks a machine-key source in this order:

1. **`OMP_UI_LITE_KEY_FILE`** — if set, that path is the key file. It must
   hold 32 raw bytes and be mode 0600; anything looser is refused with
   `LiteKeyFilePermissionError`. A missing file is created 0600 with a fresh
   key on first use. This is how a systemd credential or sealed mount hands
   the deployment its secret.
2. **Linux Secret Service (D-Bus)** — **not shipped in V1.** The proven
   binding on the withdrawn `experimental/persistent-host` branch was a
   node-gyp/libsecret N-API addon, which this package's zero-dependency and
   SEA-packaging gates exclude, and it was never proven headless. A native
   DBus client without new deps is possible but deferred; selection probes an
   injectable factory whose default resolves `null`, so Linux lands on (3).
   See `secret-service.ts` for the seam and schema notes.
3. **`<dataDir>/machine.key`** — created 0600 on first use (exclusive-create,
   so it is never briefly world-readable). The guaranteed path.

## Sealed format

`encrypt` returns one line: `v1lite:` + base64url(`nonce[12] || aes-256-gcm
ciphertext || tag[16]`), key = the 32-byte machine key, AAD = the literal
`v1lite:`. Tampering raises `LiteCipherIntegrityError`; a value with any other
prefix raises `LiteCipherVersionError` and is never attempted.

Desktop's cipher (`packages/desktop/src/main/key-cipher.ts`, Electron
`safeStorage`) is a **separate format universe**: opaque binary buffers under
Chromium/KWallet framing. Lite seals are strings with an explicit `v1lite:`
tag, so neither side can accidentally be asked to open the other's output;
the version namespaces must never overlap.

## Trust boundary of the file protectors (honest statement)

The `machine.key` fallback — and `OMP_UI_LITE_KEY_FILE` itself — protect the
key with **OS-user-grade permissions only**: mode 0600 means *other users and
non-root processes cannot read it*; anything running as your user (or root)
can. That is the same trust boundary desktop's `safeStorage` claims on its
backends: an attacker who already impersonates you has your shell, your SSH
keys, and this file. What the seal buys is defense against casual disk reads
(backups, shared images, a stolen drive at rest) and an audit trail of *never*
writing a plaintext token to disk under an "encrypted" label — the failure
mode #442's Linux `basic_text` path was rejected for. If your threat model
needs protection from your own user account, use (1) with a key handed in by
the init system at launch and never persisted world-readable, or wait for the
Secret Service binding.

## Testing

```sh
npm run test -w @omp-ui/host-lite
```

The suite covers round-trip, wrong-key and tamper rejection, version-tag
refusal, protector precedence (env file beats probe beats machine.key),
concurrent encrypt/decrypt with per-message IVs, and the 0600 mode assertions
(skipped on Windows, where POSIX mode bits are not enforced).
