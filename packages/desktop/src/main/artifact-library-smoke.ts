import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, session, type WebContents } from "electron";
import { deriveTheme, HTML_ARTIFACT_PARTITION, withArtifactReferenceContext, type ArtifactRecord, type ArtifactReference, type ThemeSource } from "@omp-ui/core";
import type { ArtifactPreparedSurface, ArtifactRuntimeSnapshot, ArtifactSurfaceSource } from "../artifact-runtime-protocol";
import { ArtifactService } from "./artifact-service";
import { ArtifactGuestBroker } from "./artifact-guest-broker";
import { installHtmlArtifactGuard } from "./html-artifact-guard";
import { MainBackend } from "./backend";
import themeSources from "../renderer/src/lib/theme-sources.json";

if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform", "headless");
  app.commandLine.appendSwitch("ozone-override-screen-size", "1600,1000");
}
// Runs only the shipped production broker/guard/preloads, from out/main and out/preload.
// Two separate Electron processes own the same durable library sequentially. No model,
// user registry, renderer dev server, mocked IPC, or temporary preload is involved.
const argument = (name: string): string | undefined => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = resolve(argument("out") ?? join(__dirname, "../artifact-library-smoke"));
const phase = argument("phase");
mkdirSync(out, { recursive: true, mode: 0o700 });
app.setPath("userData", join(out, `electron-${phase ?? `driver-${randomUUID()}`}`));
const checksum = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
interface DurableProof { owner: string; artifactId: string; codeRevisionId: string; dataSnapshotId: string; stateHash: string; datasetHash: string }
const results: Record<string, unknown> = { phase: phase ?? "driver", checks: [] as string[] };
const checks: string[] = [];
function passed(name: string): void { checks.push(name); console.log(`PASS ${name}`); }
function assertGuestSandbox(guest: WebContents): void {
  requireProof(process.platform === "linux", "This sandbox kernel proof requires Linux");
  const pid = guest.getOSProcessId();
  requireProof(pid > 0 && pid !== process.pid, "Guest has no separate renderer process");
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const argumentsOnWire = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  requireProof(!argumentsOnWire.includes("--no-sandbox") && !argumentsOnWire.includes("--disable-seccomp-filter-sandbox"), "Guest renderer was launched with sandbox denial flags");
  requireProof(/^Seccomp:\s+2\s*$/m.test(status), "Guest renderer has no active kernel seccomp filter");
}
const palette = deriveTheme((themeSources as ThemeSource[])[0]!);
const theme = {dark: palette.dark, tokens: palette.tokens};
const rootHtml = `<!doctype html><html><body><h1>Artifact library isolated smoke</h1><div id="status" role="status">Ready</div><main id="mount"></main><script>
window.notices=[];
window.ompArtifactHost.onSurfaceNotice(notice=>{window.notices.push(notice);if(notice.surfaceId===window.activeSurfaceId)document.getElementById('status').textContent=notice.reason+(notice.reloadRequired?' — Reload required':'');});
</script></body></html>`;
const artifactHtml = `<h2>Durable checklist</h2><label><input id="done" type="checkbox">Keep data across restart</label><label>Saved note<textarea id="note"></textarea></label><pre id="rows"></pre><output id="receipt">Loading</output><script>
window.loaded=window.ompArtifact.load().then(value=>{window.snapshot=value;document.getElementById('done').checked=value.state.done;document.getElementById('note').value=value.state.note||'';document.getElementById('rows').textContent=JSON.stringify(value.datasets.rows.value);document.getElementById('receipt').textContent=value.readOnly?'Read only':'Loaded';return value;});
document.getElementById('done').addEventListener('change',async event=>{try{const receipt=await window.ompArtifact.saveState({expectedStateRevision:window.snapshot.stateRevision,set:{done:event.target.checked,note:document.getElementById('note').value}});window.snapshot.stateRevision=receipt.stateRevision;window.snapshot.dataSnapshotId=receipt.dataSnapshotId;window.snapshot.state.done=event.target.checked;window.snapshot.state.note=document.getElementById('note').value;document.getElementById('receipt').textContent='Saved '+receipt.stateRevision;}catch(error){document.getElementById('receipt').textContent='Not saved';}});
</script>`;
let enabled = true;
let broker: ArtifactGuestBroker | undefined;
let service: ArtifactService | undefined;
let root: BrowserWindow | undefined;
let backend: MainBackend | undefined;
let worker: ChildProcess | undefined;
const fixtureFile = join(out, "root.html");
writeFileSync(fixtureFile, rootHtml, { mode: 0o600 });
const watchdog = setTimeout(() => { worker?.kill("SIGKILL"); writeSummary("watchdog", "Smoke exceeded 120 seconds"); app.exit(5); }, 120_000);
function writeSummary(status: string, error?: string): void {
  results.checks = checks; results.status = status;
  if (error) results.error = error;
  writeFileSync(join(out, `${phase ?? "summary"}.json`), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
}
async function rootRun<T>(script: string): Promise<T> {
  requireProof(root, "Missing real root window");
  return root.webContents.executeJavaScript(script, true) as Promise<T>;
}
async function waitTrustedNotice(surfaceId: string, reason: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await rootRun(`window.notices.some(notice=>notice.surfaceId===${JSON.stringify(surfaceId)}&&notice.reason===${JSON.stringify(reason)})`)) return;
    await delay(20);
  }
  throw new Error(`Missing trusted ${reason} notice for ${surfaceId}`);
}
async function mount(source: ArtifactSurfaceSource): Promise<{ prepared: ArtifactPreparedSurface; guest: WebContents }> {
  requireProof(root, "Missing real root window");
  // Root bridge performs the real main-frame IPC. The actual webview attach consumes
  // the one-use main ticket; Electron, not the harness, chooses its WebContents.
  const prepared = await rootRun<ArtifactPreparedSurface>(`window.ompArtifactHost.prepareSurface(${JSON.stringify(source)},${JSON.stringify(theme)})`);
  const attached = Promise.withResolvers<WebContents>();
  const listener = (_event: unknown, guest: WebContents): void => attached.resolve(guest);
  root.webContents.once("did-attach-webview", listener);
  await rootRun(`(()=>{window.activeSurfaceId=${JSON.stringify(prepared.surfaceId)};const view=document.createElement('webview');view.id='artifact';view.setAttribute('partition',${JSON.stringify(prepared.partition)});view.setAttribute('src',${JSON.stringify(prepared.url)});view.style='width:600px;height:450px';document.getElementById('mount').replaceChildren(view);return true;})()`);
  const guest = await Promise.race([attached.promise, delay(10_000).then(() => { throw new Error("Actual artifact attach timed out"); })]);
  await guest.executeJavaScript("window.loaded");
  return { prepared, guest };
}
async function release(prepared: ArtifactPreparedSurface): Promise<void> {
  await rootRun(`window.ompArtifactHost.releaseSurface(${JSON.stringify(prepared.surfaceId)})`);
  await rootRun("document.getElementById('mount').replaceChildren()");
}
async function expectGuestRefusal(guest: WebContents, script: string, name: string): Promise<void> {
  const refused = await guest.executeJavaScript(`(async()=>{try{await (${script});return false;}catch{return true;}})()`);
  requireProof(refused, `${name} unexpectedly succeeded`); passed(name);
}
async function initialize(owner: string): Promise<void> {
  const lineage = join(out, "lineage"); mkdirSync(lineage, { recursive: true, mode: 0o700 });
  service = new ArtifactService({ registryFile: join(out, "registry.json"), artifactsRoot: join(out, "artifacts"), ownerInstanceId: () => owner,
    enabled: () => enabled, scriptsEnabled: () => true,
    resolveTarget: () => ({ ownerInstanceId: owner, lineageDir: lineage, sessionId: "a1111111-1111-4111-8111-111111111111", runtimeKey: "b2222222-2222-4222-8222-222222222222", native: true, originContext: { kind: "chat" } }), sourcePath: async () => null });
  root = new BrowserWindow({ show: false, width: 800, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true, preload: join(__dirname, "../preload/index.js") } });
  if (phase === "write") {
    backend = new MainBackend(root, join(out, "backend/registry.json"), { historyEnv: {}, artifactsRoot: join(out, "backend/artifacts") });
    backend.registerIpc();
  }
  broker = new ArtifactGuestBroker({ root: root.webContents, service: () => service!, preloadPath: join(__dirname, "../preload/artifact-runtime.js") });
  installHtmlArtifactGuard(root.webContents, broker);
  await root.loadFile(fixtureFile);
  // Proxy lockdown is asynchronous and deliberately fail-closed. Wait for its
  // actual Chromium proxy configuration rather than racing an attach.
  const partition = session.fromPartition(HTML_ARTIFACT_PARTITION);
  let proxy = "";
  for (let i = 0; i < 100; i++) { proxy = await partition.resolveProxy("http://127.0.0.1/"); if (proxy.includes("127.0.0.1:9")) break; await delay(20); }
  requireProof(proxy.includes("127.0.0.1:9"), "Partition never acquired its dead loopback proxy");
}
async function writePhase(): Promise<void> {
  const owner = randomUUID(); await initialize(owner); requireProof(service && root && broker, "Fixture initialization failed");
  const disabled = await rootRun<{error: string; message: string}>("window.ompBackend.artifactList({}).then(()=>({error:'unexpected-success',message:''}),error=>({error:error.error,message:error.message}))");
  requireProof(disabled.error === "disabled" && !existsSync(join(out, "backend/artifacts")), "Default-off IPC lost its typed refusal or created storage");
  passed("actual-ipc-typed-disabled-status-without-storage");
  const now = new Date().toISOString();
  const datasets = [{ id: "rows", title: "Durable rows", schema: "rows-v1", value: [{ id: 1, title: "dataset survives", amount: 7 }], provenance: {
    source: { kind: "manual", label: "Isolated smoke fixture" }, method: { kind: "manual", description: "Local deterministic rows" }, recordedAt: now,
    captureSessionId: "a1111111-1111-4111-8111-111111111111", captureToolCallId: "render-1", trust: "agent-reported", refresh: { kind: "none", requiredSources: [] } } }];
  const managed = { protocolVersion: 1, stateSchema: "checklist-v1", initialState: { done: false, note: "" }, datasets };
  const preview = await service.stageRender({ tabId: "smoke", toolCallId: "render-preview", args: { title: "Editable before Keep", html: artifactHtml, artifact: managed } });
  const previewView = await mount({ draftId: preview.draftId });
  const previewReceipt = await previewView.guest.executeJavaScript("window.ompArtifact.saveState({expectedStateRevision:0,set:{done:true}})");
  requireProof(typeof previewReceipt.dataSnapshotId === "string", "Draft save has no durable snapshot identity");
  const previewKept = service.keep({ draftId: preview.draftId, title: "Editable before Keep" });
  const previewAccepted = service.resolveSurface({ artifactId: previewKept.artifactId, codeRevisionId: previewKept.currentCodeRevisionId, dataSnapshotId: previewKept.currentDataSnapshotId });
  requireProof(previewAccepted.state.done === true, "Keep discarded the visible draft edit");
  await release(previewView.prepared); passed("actual-prekeep-draft-save-and-human-keep-retains-state");
  const draft = await service.stageRender({ tabId: "smoke", toolCallId: "render-1", args: { title: "Durable checklist", html: artifactHtml, artifact: managed } });
  const record = service.keep({ draftId: draft.draftId, title: "Durable checklist" });
  const source = { artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: record.currentDataSnapshotId };
  const first = await mount(source);
  const guest = first.guest;
  requireProof(guest !== root.webContents && guest.hostWebContents === root.webContents, "Artifact is not a real separate guest bound to the root");
  assertGuestSandbox(guest);
  const authority = await guest.executeJavaScript("({node:typeof require,process:typeof process,backend:typeof window.ompBackend,host:typeof window.ompArtifactHost,api:Object.keys(window.ompArtifact).sort().join(','),parent:window.parent===window})");
  requireProof(authority.node === "undefined" && authority.process === "undefined" && authority.backend === "undefined" && authority.host === "undefined" && authority.api === "load,saveState" && authority.parent, "Guest received excess authority");
  passed("actual-separate-sandbox-guest-minimal-authority");
  const rootFrameAuthority = await rootRun("(()=>{const frame=document.createElement('iframe');document.body.append(frame);const absent=typeof frame.contentWindow.ompArtifactHost==='undefined'&&typeof frame.contentWindow.ompBackend==='undefined';frame.remove();return absent;})()");
  requireProof(rootFrameAuthority, "Root subframe inherited host authority"); passed("actual-root-subframe-has-no-host-bridge");
  const rogue = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, "../preload/index.js"), sandbox: true, contextIsolation: true } });
  await rogue.loadFile(fixtureFile);
  const rogueRefused = await rogue.webContents.executeJavaScript(`window.ompArtifactHost.prepareSurface(${JSON.stringify(source)},${JSON.stringify(theme)}).then(()=>false,()=>true)`);
  requireProof(rogueRefused, "Foreign root acquired a surface");
  const humanRefused = await rogue.webContents.executeJavaScript("window.ompBackend.setArtifactLibraryEnabled(true).then(()=>false,()=>true)");
  requireProof(humanRefused, "Foreign WebContents reached the real generic human settings channel");
  await rootRun("window.ompBackend.setArtifactLibraryEnabled(true)");
  rogue.destroy(); passed("actual-foreign-root-ipc-and-generic-human-channel-refused");

  let httpHits = 0; let udpHits = 0; let popupHits = 0;
  const http = createServer((_request, response) => { httpHits++; response.end("forbidden"); });
  http.on("upgrade", (_request, socket) => { httpHits++; socket.destroy(); }); http.listen(0, "127.0.0.1"); await once(http, "listening");
  const udp = createSocket("udp4"); udp.on("message", () => udpHits++); udp.bind(0, "127.0.0.1"); await once(udp, "listening");
  const address = http.address(); requireProof(address && typeof address !== "string", "Missing HTTP probe port");
  const port = address.port; const stunPort = udp.address().port;
  guest.on("did-create-window", () => popupHits++);
  let unpreventedDownloads = 0;
  const downloadSession = session.fromPartition(HTML_ARTIFACT_PARTITION);
  const downloads = join(out, "downloads"); mkdirSync(downloads, { recursive: true, mode: 0o700 });
  downloadSession.setDownloadPath(downloads);
  const downloadAttempt = (event: Electron.Event): void => { if (!event.defaultPrevented) unpreventedDownloads++; };
  downloadSession.on("will-download", downloadAttempt);
  try {
    const denial = await guest.executeJavaScript(`(async()=>{
      const results={};
      results.http=await fetch('http://127.0.0.1:${port}/loopback').then(()=>false,()=>true);
      results.external=await fetch('https://example.com/artifact-probe').then(()=>false,()=>true);
      const socketResult=Promise.withResolvers();
      const socket=new WebSocket('ws://127.0.0.1:${port}/socket');
      socket.onerror=()=>socketResult.resolve(true);socket.onopen=()=>socketResult.resolve(false);
      setTimeout(()=>socketResult.resolve(socket.readyState!==1),500);results.websocket=await socketResult.promise;
      results.popup=window.open('https://example.com')===null;
      results.devices=!navigator.mediaDevices||await navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return false;},()=>true);
      const peer=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stunPort}'}]});
      peer.createDataChannel('probe');await peer.setLocalDescription(await peer.createOffer());results.stunAttempted=!!peer.localDescription;
      const settle=Promise.withResolvers();setTimeout(settle.resolve,1000);await settle.promise;peer.close();
      const a=document.createElement('a');a.href='data:text/plain,forbidden-download';a.download='artifact-forbidden.txt';a.click();
      return results;
    })()`);
    await delay(300);
    requireProof(denial.http && denial.external && denial.websocket && denial.popup && denial.devices && denial.stunAttempted && httpHits === 0 && udpHits === 0 && popupHits === 0 && unpreventedDownloads === 0 && !existsSync(join(downloads, "artifact-forbidden.txt")), `Network/device/download denial failed: ${JSON.stringify({ denial, httpHits, udpHits, popupHits, unpreventedDownloads })}`);
    requireProof(guest.getURL().startsWith(first.prepared.url), "Artifact navigated away from canonical document");
    passed("actual-http-external-loopback-websocket-stun-popup-devices-denied");
  } finally { http.close(); udp.close(); downloadSession.removeListener("will-download", downloadAttempt); }

  const urlBeforeTheme = guest.getURL();
  await rootRun(`window.ompArtifactHost.updateTheme(${JSON.stringify(first.prepared.surfaceId)},{dark:false,tokens:{'--color-ink':'#123456'}})`);
  for (let i = 0; i < 100; i++) {
    if (await guest.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--color-ink').trim()") === "#123456") break;
    await delay(20);
  }
  requireProof(guest.getURL() === urlBeforeTheme, "Theme replaced the document URL");
  requireProof(await guest.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--color-ink').trim()") === "#123456", "Theme CSS event did not update the actual guest"); passed("actual-theme-css-event-preserves-document");
  const second = await rootRun<ArtifactPreparedSurface>(`window.ompArtifactHost.prepareSurface(${JSON.stringify(source)},${JSON.stringify(theme)})`);
  requireProof(second.readOnly, "Second viewer obtained the writer"); await rootRun(`window.ompArtifactHost.releaseSurface(${JSON.stringify(second.surfaceId)})`); passed("second-viewer-is-readonly");
  const reused = await rootRun(`(()=>{const view=document.createElement('webview');view.setAttribute('partition',${JSON.stringify(first.prepared.partition)});view.setAttribute('src',${JSON.stringify(first.prepared.url)});document.body.append(view);const pending=Promise.withResolvers();setTimeout(()=>{let failed;try{failed=!view.getWebContentsId()}catch{failed=true}view.remove();pending.resolve(failed)},250);return pending.promise;})()`);
  requireProof(reused, "Consumed attach ticket was reusable"); passed("actual-consumed-attach-ticket-refused");
  const lazyDraft = await service.stageRender({tabId: "smoke", toolCallId: "render-lazy", args: {title: "Lazy state access", html: "<p>State loads on explicit use</p>", artifact: managed}});
  const lazyRecord = service.keep({draftId: lazyDraft.draftId, title: "Lazy state access"});
  const lazyPrepared = await rootRun<ArtifactPreparedSurface>(`window.ompArtifactHost.prepareSurface(${JSON.stringify({artifactId: lazyRecord.artifactId, codeRevisionId: lazyRecord.currentCodeRevisionId, dataSnapshotId: lazyRecord.currentDataSnapshotId})},${JSON.stringify(theme)})`);
  const lazyAttached = once(root.webContents, "did-attach-webview");
  await rootRun(`(()=>{const view=document.createElement('webview');view.id='lazy-artifact';view.setAttribute('partition',${JSON.stringify(lazyPrepared.partition)});view.setAttribute('src',${JSON.stringify(lazyPrepared.url)});document.body.append(view);return true;})()`);
  const [, lazyGuest] = await lazyAttached as [unknown, WebContents];
  const expired = await rootRun<ArtifactPreparedSurface>(`window.ompArtifactHost.prepareSurface(${JSON.stringify(source)},${JSON.stringify(theme)})`);
  await delay(30_100);
  const expiredRefused = await rootRun(`(()=>{const view=document.createElement('webview');view.setAttribute('partition',${JSON.stringify(expired.partition)});view.setAttribute('src',${JSON.stringify(expired.url)});document.body.append(view);const pending=Promise.withResolvers();setTimeout(()=>{let failed;try{failed=!view.getWebContentsId()}catch{failed=true}view.remove();pending.resolve(failed)},250);return pending.promise;})()`);
  requireProof(expiredRefused, "Expired ticket attached after its 30 second deadline"); passed("actual-30-second-ticket-expiration-refused");
  const lazyState = await lazyGuest.executeJavaScript("window.ompArtifact.load()");
  requireProof(lazyState.state.done === false, "A first API call after 30 seconds lost its preload admission");
  await rootRun(`window.ompArtifactHost.releaseSurface(${JSON.stringify(lazyPrepared.surfaceId)})`);
  await rootRun("document.getElementById('lazy-artifact').remove()");
  passed("actual-first-state-use-after-ticket-deadline");
  const untrustedGuest = Promise.withResolvers<WebContents>();
  root.webContents.once("did-attach-webview", (_event, contents) => untrustedGuest.resolve(contents));
  await rootRun(`(()=>{const view=document.createElement('webview');view.id='forged';view.setAttribute('partition',${JSON.stringify(first.prepared.partition)});view.setAttribute('preload',${JSON.stringify(`file://${join(__dirname, "../preload/index.js")}`)});view.setAttribute('webpreferences','nodeIntegration=yes,contextIsolation=no,sandbox=no');view.setAttribute('src','data:text/html,<p>Forged document</p>');document.body.append(view);return true})()`);
  const untrusted = await Promise.race([untrustedGuest.promise, delay(5000).then(() => { throw new Error("Forged document attach probe timed out"); })]);
  const stripped = await untrusted.executeJavaScript("typeof require==='undefined'&&typeof window.ompBackend==='undefined'&&typeof window.ompArtifact==='undefined'");
  assertGuestSandbox(untrusted);
  requireProof(stripped, "Renderer preload injection reached a guest");
  await rootRun("document.getElementById('forged').remove()"); passed("actual-renderer-preload-preference-and-argument-authority-stripped");
  await expectGuestRefusal(guest, "window.ompArtifact.saveState({expectedStateRevision:0,set:{text:'x'.repeat(1048576)}})", "oversize-refused-before-save");
  await expectGuestRefusal(guest, "(()=>{const value={};value.self=value;return window.ompArtifact.saveState({expectedStateRevision:0,set:value})})()", "cycle-refused-before-save");
  await expectGuestRefusal(guest, "window.ompArtifact.saveState({expectedStateRevision:0,set:JSON.parse('{\"__proto__\":{}}')})", "prototype-refused-before-save");
  const rate = await guest.executeJavaScript("Promise.all(Array.from({length:32},()=>window.ompArtifact.load().then(()=>false,()=>true))).then(rows=>rows.filter(Boolean).length)");
  requireProof(rate > 0, "Runtime did not refuse flood/inflight calls"); await delay(1100); passed("actual-rate-inflight-refusal-with-recovery");

  // The fault is in real SQLite, not a fake service: abort insertion of the immutable
  // snapshot after the transaction has begun. The receipt must remain Not saved.
  const sql = new DatabaseSync(join(out, "artifacts/library.sqlite"));
  sql.exec("CREATE TRIGGER artifact_smoke_failure BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'artifact smoke storage failure'); END");
  await expectGuestRefusal(guest, "window.ompArtifact.saveState({expectedStateRevision:0,set:{done:true}})", "actual-sqlite-transaction-failure-refused");
  await waitTrustedNotice(first.prepared.surfaceId, "not-saved");
  requireProof(await rootRun("document.getElementById('status').textContent") === "not-saved", "Trusted host reported Saved after failed storage transaction");
  sql.exec("DROP TRIGGER artifact_smoke_failure"); sql.close();
  await guest.executeJavaScript("document.getElementById('note').value='My durable review note';document.getElementById('done').click()");
  for (let i = 0; i < 100; i++) { if (await guest.executeJavaScript("document.getElementById('receipt').textContent") === "Saved 1") break; await delay(20); }
  requireProof(await guest.executeJavaScript("(()=>{const el=document.getElementById('receipt');return el.textContent==='Saved 1'&&el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden'})()"), "Checklist did not visibly acknowledge durable save");
  await waitTrustedNotice(first.prepared.surfaceId, "saved");
  requireProof(await rootRun("document.getElementById('status').textContent") === "saved", "Root did not receive trusted Saved receipt");
  writeFileSync(join(out, "saved-receipt.png"), (await root.webContents.capturePage()).toPNG(), { mode: 0o600 });
  await expectGuestRefusal(guest, "window.ompArtifact.saveState({expectedStateRevision:0,set:{done:false}})", "actual-stale-state-cas-refused");
  passed("valid-checklist-save-after-refusal-and-failure");
  const saved = await guest.executeJavaScript("window.ompArtifact.load()") as ArtifactRuntimeSnapshot;
  requireProof(saved.dataSnapshotId && saved.stateRevision === 1 && saved.state && typeof saved.state === "object" && !Array.isArray(saved.state) && saved.state.done === true, "Saved checklist snapshot is wrong");
  const durable: DurableProof = { owner, artifactId: record.artifactId, codeRevisionId: record.currentCodeRevisionId, dataSnapshotId: saved.dataSnapshotId, stateHash: checksum(saved.state), datasetHash: checksum(saved.datasets) };
  writeFileSync(join(out, "durable.json"), JSON.stringify(durable), { mode: 0o600 });

  const liveSource = { ...source, dataSnapshotId: saved.dataSnapshotId };
  const reference: ArtifactReference = service.reference({ targetTabId: "smoke", ...liveSource, includeData: false });
  service.admitPrompt({ tabId: "smoke", text: withArtifactReferenceContext("Update code only.", [reference]) });
  const candidate = await service.stageRender({ tabId: "smoke", toolCallId: "render-2", args: { title: "Candidate", html: `<p id="accepted-code-marker">New accepted code</p>${artifactHtml}`, artifact: { ...managed, basedOn: { referenceId: reference.referenceId } } } });
  const accepted: ArtifactRecord = service.acceptRevision({ draftId: candidate.draftId, expectedCodeRevisionId: record.currentCodeRevisionId });
  await waitTrustedNotice(first.prepared.surfaceId, "changed");
  requireProof(await rootRun("document.getElementById('status').textContent") === "changed — Reload required", "External accepted head did not show a trusted reload notice");
  requireProof(await guest.executeJavaScript(`document.getElementById('done').checked&&!document.getElementById('accepted-code-marker')&&window.snapshot.codeRevisionId===${JSON.stringify(record.currentCodeRevisionId)}`), "External head silently swapped the old visible code or checklist data");
  writeFileSync(join(out, "reload-required.png"), (await root.webContents.capturePage()).toPNG(), { mode: 0o600 });
  await expectGuestRefusal(guest, "window.ompArtifact.saveState({expectedStateRevision:1,set:{done:false}})", "external-code-head-revokes-existing-writer");
  await release(first.prepared);
  const current = await mount({ artifactId: accepted.artifactId, codeRevisionId: accepted.currentCodeRevisionId, dataSnapshotId: accepted.currentDataSnapshotId });
  requireProof(await current.guest.executeJavaScript("!!document.getElementById('accepted-code-marker')&&document.getElementById('done').checked"), "Explicit reload did not load the new accepted code with preserved saved state");
  const checkAdmission = service.assertBoundSurface.bind(service);
  const waiting = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  service.assertBoundSurface = (binding) => { waiting.resolve(); return unblock.promise.then(() => checkAdmission(binding)); };
  const delayedWrite = current.guest.executeJavaScript("window.ompArtifact.saveState({expectedStateRevision:1,set:{done:false}}).then(()=>false,()=>true)");
  await waiting.promise;
  enabled = false; service.setEnabled(false); unblock.resolve();
  requireProof(await delayedWrite, "An admitted delayed save committed after disable");
  service.assertBoundSurface = checkAdmission;
  passed("actual-delayed-save-revoked-before-commit");
  await waitTrustedNotice(current.prepared.surfaceId, "disabled");
  requireProof(await rootRun("document.getElementById('status').textContent") === "disabled — Reload required", "Disabled surface lacks trusted status");
  writeFileSync(join(out, "disabled.png"), (await root.webContents.capturePage()).toPNG(), { mode: 0o600 });
  await release(current.prepared);
  enabled = true; service.setEnabled(true);
  const reopened = await mount({artifactId: accepted.artifactId, codeRevisionId: accepted.currentCodeRevisionId, dataSnapshotId: accepted.currentDataSnapshotId});
  const retained = await reopened.guest.executeJavaScript("window.ompArtifact.load()");
  requireProof(retained.state.done === true && retained.state.note === "My durable review note", "Re-enable changed the last acknowledged data");
  await release(reopened.prepared);
  passed("actual-reenable-retains-last-acknowledged-data");
  results.durable = durable; passed("visible-reload-disable-status-and-old-snapshot-preserved");
}
async function readPhase(): Promise<void> {
  const durable = JSON.parse(readFileSync(join(out, "durable.json"), "utf8")) as DurableProof;
  await initialize(durable.owner);
  const mounted = await mount({ artifactId: durable.artifactId, codeRevisionId: durable.codeRevisionId, dataSnapshotId: durable.dataSnapshotId });
  const loaded = await mounted.guest.executeJavaScript("window.ompArtifact.load()") as ArtifactRuntimeSnapshot;
  requireProof(checksum(loaded.state) === durable.stateHash && checksum(loaded.datasets) === durable.datasetHash, "Restart changed durable state or datasets");
  requireProof(await mounted.guest.executeJavaScript("document.getElementById('done').checked&&document.getElementById('note').value==='My durable review note'"), "Restarted actual checklist lost saved check or note");
  requireProof(loaded.readOnly, "Historical code after external accept was not read-only");
  await expectGuestRefusal(mounted.guest, "window.ompArtifact.saveState({expectedStateRevision:1,set:{done:false}})", "historical-viewer-remains-readonly-after-process-restart");
  passed("separate-process-restart-checklist-and-dataset-checksums");
  await release(mounted.prepared); results.durable = durable;
}
async function driver(): Promise<void> {
  const runDirectory = join(out, `run-${randomUUID()}`);
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  results.runDirectory = runDirectory;
  for (const workerPhase of ["write", "read"]) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(runDirectory, "config"), XDG_DATA_HOME: join(runDirectory, "data") };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [join(__dirname, "artifact-library-smoke.js"), `--phase=${workerPhase}`, `--out=${runDirectory}`, ...process.argv.filter(value => /^--(?:ozone-platform|no-sandbox|disable-gpu)(?:=|$)/.test(value))], { stdio: "inherit", env: childEnv });
    worker = child;
    const exited = Promise.withResolvers<void>();
    child.once("error", exited.reject);
    child.once("exit", (code, signal) => {
      worker = undefined;
      if (code === 0) exited.resolve(); else exited.reject(new Error(`${workerPhase} process exited ${code ?? signal}`));
    });
    await exited.promise;
    results[workerPhase] = JSON.parse(readFileSync(join(runDirectory, `${workerPhase}.json`), "utf8"));
    passed(`separate-electron-process-${workerPhase}`);
  }
}
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  try {
    if (phase === "write") await writePhase(); else if (phase === "read") await readPhase(); else await driver();
    await broker?.dispose(); service?.close(); await backend?.killAll(); root?.destroy();
    clearTimeout(watchdog); writeSummary("passed"); console.log(`FINISH artifact-library ${phase ?? "summary"}=passed out=${out}`); app.exit(0);
  } catch (error) {
    await broker?.dispose(); service?.close(); await backend?.killAll(); root?.destroy();
    clearTimeout(watchdog); writeSummary("failed", error instanceof Error ? error.stack : String(error)); console.error(error); app.exit(1);
  }
});
