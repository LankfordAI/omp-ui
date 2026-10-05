// PROTOTYPE (#754): throwaway.
// Drives a running omp-ui (Electron started with OMP_UI_CDP_PORT=<port>) over raw CDP.
//
// Usage:
//   node drive.mjs run <id> [--project <path>] [--port 9754]
//   node drive.mjs eval '<js>' [--port 9754]          (debug: prints the awaited, by-value result)
//   node drive.mjs close-tab <tabId> [--port 9754]    (ompBackend.terminateSession)
//
// Run specs: ../runs.json. Evidence: ../evidence/runs/<id>/ (frames.jsonl, summary.json, *.png).
// Control file: ~/.cache/omp-ui-proto-754/control.json (main re-reads it per tool call).
//
// Renderer facts this script leans on (verified in source):
//   window.ompBackend = makeBackendClient(...) minus onBrowserPaneFrame (preload/index.ts:12-22);
//   onRpcFrame(cb) returns undefined — no unsubscribe (preload/index.ts:15-18, backend-channels.ts:1572-1573),
//   so every hook is gated on window.__p754_active === <runKey> and goes inert at run end.
//   Sidebar project row: <section> holding button[aria-expanded][title=<project.path>] (Sidebar.tsx:372-377)
//   and IconButton aria-label "new session" (Sidebar.tsx:473, en.ts:2108, controls.tsx:109-113).
//   Tabs: div[data-tab-id] toggled by display (App.tsx:506-511). Composer: textarea[data-composer-input],
//   disabled while booting (Composer.tsx:1011-1016); plain Enter submits (Composer.tsx:810-812).
//   Build/Plan: ChoiceCapsule role=group aria-label "session mode", option text "plan"
//   (BuildPlanControl.tsx:48-55, controls.tsx:479-497, en.ts:1681); click -> setPlanMode ->
//   prompt "/omp-ui-plan on <state.planFormat>" (session-params.ts:1308-1318, plan.ts:23-28).
//   Approval card: [data-approval-card], buttons "Deny" then "Allow" (ApprovalCard.tsx:54,92-98, en.ts:107-108);
//   answer value "Approve" (approval.ts:18). Tool rows: [data-item-id=<toolCallId>] (TranscriptView.tsx:1040,
//   transcript.ts:783-788); header = first <button> of the ToolCard Panel (ToolCard.tsx:620-623),
//   open body = Panel > .border-t (ToolCard.tsx:673-674).

import WebSocket from "ws";
import { spawn, execFileSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(SCRIPT_DIR, "..");
const RUNS_FILE = join(PROTO_DIR, "runs.json");
const EVIDENCE_DIR = join(PROTO_DIR, "evidence");
const CACHE_DIR = join(homedir(), ".cache", "omp-ui-proto-754");
const CONTROL_FILE = join(CACHE_DIR, "control.json");
const FRESH_VAULT_DIR = "/home/alankford/Documents/Obsidian/omp-ui/";

const BASE_CONTROL = {
	vaultPath: "/home/alankford/Documents/Obsidian",
	vaultId: "ee8bdab8baa42089",
	vaultName: "Obsidian",
	homeFolder: "omp-ui/",
	loadMode: "essential",
	guidance: "message",
	planGuard: true,
	searchDelayMs: 0,
	searchBackend: "fs",
	readImages: true,
};

const KEEP = [
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"message_end",
	"agent_end",
	"extension_ui_request",
	"response",
];

const TURN_CAP_MS = 15 * 60_000;
const QUIET_AFTER_END_MS = 3_000;
const DIALOG_CANCEL_MS = 60_000;
const PLAN_REVIEW_ABORT_MS = 10_000;
const BLOCKING_METHODS = new Set(["select", "confirm", "input", "editor"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t = Date.now()) => new Date(t).toISOString();
const js = (v) => JSON.stringify(v);

// ---------------------------------------------------------------- CDP

class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		ws.on("message", (data) => {
			const msg = JSON.parse(String(data));
			if (msg.id === undefined) return;
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
			else p.resolve(msg.result);
		});
		ws.on("close", () => {
			for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
			this.pending.clear();
		});
	}
	send(method, params = {}) {
		const id = this.nextId++;
		return new Promise((resolveP, reject) => {
			this.pending.set(id, { resolve: resolveP, reject, method });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}
	async ev(expression) {
		const r = await this.send("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new Error(`evaluate: ${d.exception?.description ?? d.text}`);
		}
		return r.result.value;
	}
	close() {
		this.ws.close();
	}
}

function openSocket(url) {
	return new Promise((resolveP, reject) => {
		const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
		ws.once("open", () => resolveP(ws));
		ws.once("error", reject);
	});
}

async function connect(port) {
	const res = await fetch(`http://127.0.0.1:${port}/json`);
	const targets = await res.json();
	const pages = targets.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
	if (pages.length === 0) throw new Error(`no page target on port ${port}`);
	// Several pages can exist (browser pane views); the app renderer is the one with ompBackend.
	for (const page of pages) {
		const cdp = new Cdp(await openSocket(page.webSocketDebuggerUrl));
		let ok = false;
		try {
			ok = (await cdp.ev("typeof window.ompBackend === 'object' && window.ompBackend !== null")) === true;
		} catch {
			ok = false;
		}
		if (ok) {
			try {
				await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
			} catch {
				// Optional: only helps focus-dependent UI while the window is in the background.
			}
			return { cdp, target: { id: page.id, url: page.url, title: page.title } };
		}
		cdp.close();
	}
	throw new Error(`no page target exposes window.ompBackend (${pages.map((p) => p.url).join(", ")})`);
}

async function screenshot(cdp, file, clip) {
	const params = { format: "png" };
	if (clip) params.clip = { ...clip, scale: 1 };
	const r = await cdp.send("Page.captureScreenshot", params);
	writeFileSync(file, Buffer.from(r.data, "base64"));
	return file;
}

/** Element rect clamped to the viewport; null when missing or off-screen. */
async function rectOf(cdp, selectorExpr) {
	return cdp.ev(`(() => {
		const el = ${selectorExpr};
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const x = Math.max(0, r.left), y = Math.max(0, r.top);
		const w = Math.min(r.right, innerWidth) - x, h = Math.min(r.bottom, innerHeight) - y;
		if (w <= 0 || h <= 0) return null;
		return { x, y, width: w, height: h };
	})()`);
}

const tabSel = (tabId) => `document.querySelector('[data-tab-id="' + CSS.escape(${js(tabId)}) + '"]')`;

// ---------------------------------------------------------------- frames

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("");
}

class FrameLog {
	constructor(cdp, runKey, file) {
		this.cdp = cdp;
		this.runKey = runKey;
		this.file = file;
		this.frames = [];
		this.listeners = [];
		this.timer = null;
		this.draining = Promise.resolve();
	}
	async install() {
		return this.cdp.ev(`(() => {
			const RID = ${js(this.runKey)};
			const NAME = "__p754_" + RID;
			const KEEP = new Set(${js(KEEP)});
			const CAP = 20000;
			window[NAME] = [];
			window.__p754_active = RID;
			const shrink = (f) => JSON.parse(JSON.stringify(f, (k, v) =>
				k === "providerPayload" ? undefined
				: typeof v === "string" && v.length > CAP ? v.slice(0, CAP) + "…[+" + (v.length - CAP) + " chars]"
				: v));
			const unsub = window.ompBackend.onRpcFrame((tabId, f) => {
				if (window.__p754_active !== RID || !f || !KEEP.has(f.type)) return;
				const g = f.type === "response" && f.command !== "get_state"
					? { type: "response", id: f.id, command: f.command, success: f.success, error: f.error }
					: f;
				let kept;
				try { kept = shrink(g); } catch (e) { kept = { type: f.type, shrinkError: String(e) }; }
				window[NAME].push({ t: Date.now(), tabId, f: kept });
			});
			window["__p754_unsub_" + RID] = typeof unsub === "function" ? unsub : null;
			return { unsubscribe: typeof unsub === "function" };
		})()`);
	}
	start() {
		this.timer = setInterval(() => {
			this.draining = this.draining.then(() => this.drain()).catch((e) => console.error(`[drain] ${e.message}`));
		}, 500);
	}
	async drain() {
		const batch = await this.cdp.ev(`(() => {
			const n = "__p754_" + ${js(this.runKey)};
			const a = window[n] || [];
			window[n] = [];
			return a;
		})()`);
		if (!Array.isArray(batch) || batch.length === 0) return;
		appendFileSync(this.file, batch.map((e) => `${JSON.stringify(e)}\n`).join(""));
		this.frames.push(...batch);
		for (const l of this.listeners) l(batch);
	}
	onBatch(fn) {
		this.listeners.push(fn);
	}
	async stop() {
		clearInterval(this.timer);
		await this.draining;
		await this.drain().catch(() => {});
		await this.cdp
			.ev(`(() => {
				const RID = ${js(this.runKey)};
				const u = window["__p754_unsub_" + RID];
				if (typeof u === "function") u();
				if (window.__p754_active === RID) window.__p754_active = null;
				delete window["__p754_" + RID];
				delete window["__p754_unsub_" + RID];
				return true;
			})()`)
			.catch(() => {});
	}
	forTab(tabId) {
		return this.frames.filter((e) => e.tabId === tabId);
	}
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() >= until) return null;
		await sleep(stepMs);
	}
}

// ---------------------------------------------------------------- run

function loadRun(id) {
	const runs = JSON.parse(readFileSync(RUNS_FILE, "utf8"));
	const run = runs.find((r) => r.id === id);
	if (!run) throw new Error(`run ${id} not in ${RUNS_FILE} (have ${runs.map((r) => r.id).join(", ")})`);
	return run;
}

function prepareRunDir(id) {
	const dir = join(EVIDENCE_DIR, "runs", id);
	if (existsSync(dir)) renameSync(dir, `${dir}.prev-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

async function resolveProject(cdp, projectArg) {
	const state = await cdp.ev("window.ompBackend.getState()");
	const paths = (state?.projects ?? []).map((g) => g.project.path);
	if (!projectArg) {
		if (paths.length === 0) throw new Error("no projects registered; pass --project");
		return { path: paths[0], added: false };
	}
	const want = resolve(projectArg.replace(/^~(?=\/|$)/, homedir()));
	if (paths.includes(want)) return { path: want, added: false };
	const record = await cdp.ev(`window.ompBackend.addProject(${js(want)})`);
	return { path: record?.path ?? want, added: true };
}

async function clickNewSession(cdp, projectPath) {
	return cdp.ev(`(() => {
		const want = ${js(projectPath)};
		const row = [...document.querySelectorAll("section button[aria-expanded][title]")]
			.find((b) => b.getAttribute("title") === want);
		if (!row) return { ok: false, reason: "project row not found (sidebar collapsed or compact?)" };
		const btn = row.closest("section").querySelector('button[aria-label="new session"]');
		if (!btn) return { ok: false, reason: "new session button not found in project section" };
		if (btn.disabled) return { ok: false, reason: "new session button disabled" };
		btn.click();
		return { ok: true };
	})()`);
}

const domTabIds = (cdp) => cdp.ev(`[...document.querySelectorAll("[data-tab-id]")].map((e) => e.dataset.tabId)`);

async function composerState(cdp, tabId) {
	return cdp.ev(`(() => {
		const tab = ${tabSel(tabId)};
		const el = tab && tab.querySelector("[data-composer-input]");
		if (!el) return { present: false };
		return { present: true, disabled: el.disabled, value: el.value, shown: tab.style.display !== "none" };
	})()`);
}

async function sendPrompt(cdp, log, tabId, text) {
	const focused = await cdp.ev(`(() => {
		const el = ${tabSel(tabId)}?.querySelector("[data-composer-input]");
		if (!el || el.disabled) return false;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		return document.activeElement === el;
	})()`);
	if (!focused) throw new Error("composer not focusable");
	let composerVia = "insertText";
	await cdp.send("Input.insertText", { text });
	await sleep(150);
	let st = await composerState(cdp, tabId);
	if (st.value !== text) {
		composerVia = "nativeSetter";
		await cdp.ev(`(() => {
			const el = ${tabSel(tabId)}.querySelector("[data-composer-input]");
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${js(text)});
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.focus();
		})()`);
		await sleep(150);
		st = await composerState(cdp, tabId);
	}
	const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
	const sentAt = Date.now();
	await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r", unmodifiedText: "\r" });
	await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
	const cleared = await waitFor(async () => (await composerState(cdp, tabId)).value === "", 5_000);
	let submitVia = "enter";
	if (!cleared) {
		submitVia = "rpcSend";
		await cdp.ev(
			`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "prompt", id: `p754-prompt-${sentAt}`, message: text })})`,
		);
	}
	return { sentAt, composerVia, submitVia };
}

async function waitTurn(log, tabId, sinceT) {
	const until = sinceT + TURN_CAP_MS;
	for (;;) {
		const frames = log.forTab(tabId).filter((e) => e.t > sinceT);
		const ends = frames.filter((e) => e.f.type === "agent_end");
		const lastEnd = ends.at(-1);
		if (lastEnd) {
			const activityAfter = frames.some(
				(e) => e.t > lastEnd.t && (e.f.type === "tool_execution_start" || e.f.type === "message_end"),
			);
			if (!activityAfter && Date.now() - lastEnd.t >= QUIET_AFTER_END_MS) return { ended: true, endT: lastEnd.t };
		}
		if (Date.now() >= until) return { ended: false };
		await sleep(500);
	}
}

async function run(id, flags) {
	const spec = loadRun(id);
	const port = Number(flags.port ?? 9754);
	const dir = prepareRunDir(id);
	const startedAt = iso();
	const runKey = `${id.replace(/\W/g, "_")}_${Date.now()}`;

	// 1. control file
	const control = { ...BASE_CONTROL, ...(spec.control ?? {}) };
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CONTROL_FILE, `${JSON.stringify(control, null, 2)}\n`);
	writeFileSync(join(dir, "control.json"), `${JSON.stringify(control, null, 2)}\n`);

	// 2. fresh vault folder
	let freshVault = null;
	if (spec.freshVault) {
		const existed = existsSync(FRESH_VAULT_DIR);
		rmSync(FRESH_VAULT_DIR, { recursive: true, force: true });
		freshVault = { deleted: FRESH_VAULT_DIR, existed, at: iso() };
	}

	const { cdp, target } = await connect(port);
	const log = new FrameLog(cdp, runKey, join(dir, "frames.jsonl"));
	const summary = {
		id,
		control,
		prompts: spec.prompts,
		project: null,
		tabId: null,
		target,
		freshVault,
		approvalMode: spec.approvalMode ?? null,
		planVia: null,
		planStatusSeen: null,
		approvalVia: null,
		approvals: {},
		approvalLog: [],
		dialogs: [],
		promptLog: [],
		calls: [],
		cards: [],
		stills: [],
		obsidianProbes: [],
		finalAssistantText: null,
		timeouts: [],
		errors: [],
		startedAt,
		endedAt: null,
		mainLogWindow: { from: startedAt, to: null },
		rubric: null,
	};
	const background = [];
	let tabId = null;
	let projectPath = null;
	let promptIndex = -1;

	try {
		// 3. hook
		summary.hook = await log.install();
		log.start();

		// 4. new session
		const project = await resolveProject(cdp, flags.project);
		projectPath = project.path;
		summary.project = project;
		if (project.added) await waitFor(async () => (await clickNewSessionProbe(cdp, projectPath)) === true, 10_000);
		const before = new Set(await domTabIds(cdp));
		const stateBefore = await cdp.ev("window.ompBackend.getState()");
		const sessionsBefore = new Set((stateBefore?.projects ?? []).flatMap((g) => g.sessions.map((s) => s.tabId)));
		const clicked = await clickNewSession(cdp, projectPath);
		if (!clicked.ok) throw new Error(`new session: ${clicked.reason}`);
		const clickT = Date.now();
		tabId = await waitFor(async () => (await domTabIds(cdp)).find((t) => !before.has(t)) ?? null, 30_000);
		if (!tabId) throw new Error("no new [data-tab-id] appeared within 30 s");
		summary.tabId = tabId;
		const stateAfter = await cdp.ev("window.ompBackend.getState()");
		summary.tabInState = (stateAfter?.projects ?? []).some((g) =>
			g.sessions.some((s) => s.tabId === tabId && !sessionsBefore.has(s.tabId)),
		);
		await waitReady(cdp, log, tabId, clickT, "spawn", summary);

		// Live frame handlers (approvals, dialogs, Obsidian probe).
		const handled = new Set();
		let approvalChain = Promise.resolve();
		let approvalN = 0;
		let writeCount = 0;
		log.onBatch((batch) => {
			for (const e of batch) {
				if (e.tabId !== tabId) continue;
				const f = e.f;
				if (f.type === "extension_ui_request" && typeof f.id === "string" && !handled.has(f.id)) {
					const title = typeof f.title === "string" ? f.title : "";
					if (f.method === "select" && title.startsWith("Allow tool:")) {
						handled.add(f.id);
						const n = ++approvalN;
						approvalChain = approvalChain.then(() => handleApproval(cdp, dir, tabId, f, n, summary)).catch((err) =>
							summary.errors.push(`approval ${n}: ${err.message}`),
						);
					} else if (title.startsWith("omp-ui:plan-review:")) {
						handled.add(f.id);
						background.push(handlePlanReview(cdp, dir, tabId, f, summary, promptIndex));
					} else if (BLOCKING_METHODS.has(f.method)) {
						handled.add(f.id);
						background.push(handleDialog(cdp, dir, tabId, f, summary, promptIndex));
					}
				}
				if (spec.obsidianProbe && f.type === "tool_execution_end" && f.toolName === "omp-ui_vault_write") {
					writeCount += 1;
					const pi = promptIndex;
					const suffix = writeCount > 1 ? `-w${writeCount}` : "";
					for (const [delay, tag] of [
						[1_000, "1s"],
						[5_000, "5s"],
					]) {
						const label = `after-edit-${pi}${suffix}-${tag}`;
						background.push(sleep(delay).then(() => runProbe(dir, label, summary)));
					}
				}
			}
		});

		// 5. approval mode / plan
		if (spec.approvalMode) {
			const t0 = Date.now();
			await cdp.ev(`window.ompBackend.setSessionApprovalMode(${js(tabId)}, ${js(spec.approvalMode)})`);
			summary.approvalModeSet = { requestedAt: iso(t0), resolvedAt: iso() };
			const sameTab = (await domTabIds(cdp)).includes(tabId);
			summary.approvalModeSet.tabIdStable = sameTab;
			await waitReady(cdp, log, tabId, t0, "relaunch", summary);
		}
		if (spec.plan) {
			const t0 = Date.now();
			const click = await cdp.ev(`(() => {
				const tab = ${tabSel(tabId)};
				for (const g of tab.querySelectorAll('[role="group"][aria-label="session mode"]')) {
					const b = [...g.querySelectorAll("button")].find((x) => x.textContent.trim().toLowerCase() === "plan");
					if (b && !b.disabled) { b.click(); return { ok: true }; }
				}
				return { ok: false };
			})()`);
			let seen = click.ok ? await waitPlanOn(log, tabId, t0) : null;
			summary.planVia = "click";
			if (!seen) {
				summary.planVia = "rpcSend";
				const t1 = Date.now();
				await cdp.ev(
					`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "prompt", id: `p754-plan-${t1}`, message: "/omp-ui-plan on md" })})`,
				);
				seen = await waitPlanOn(log, tabId, t1);
			}
			summary.planStatusSeen = seen ? iso(seen.t) : null;
		}

		// 6/7. prompts
		for (let i = 0; i < spec.prompts.length; i++) {
			promptIndex = i;
			const ready = await waitFor(async () => {
				const s = await composerState(cdp, tabId);
				return s.present && !s.disabled;
			}, 60_000);
			if (!ready) throw new Error(`composer not ready before prompt ${i}`);
			const sent = await sendPrompt(cdp, log, tabId, spec.prompts[i]);
			for (const ms of spec.stillsAt ?? []) {
				background.push(
					sleep(Math.max(0, sent.sentAt + ms - Date.now())).then(async () => {
						const file = join(dir, `still-${ms}.png`);
						await screenshot(cdp, file).catch((err) => summary.errors.push(`still ${ms}: ${err.message}`));
						summary.stills.push({ promptIndex: i, ms, file, at: iso() });
					}),
				);
			}
			const turn = await waitTurn(log, tabId, sent.sentAt);
			const entry = { index: i, sentAt: iso(sent.sentAt), composerVia: sent.composerVia, submitVia: sent.submitVia };
			if (!turn.ended) {
				const abortT = Date.now();
				await cdp.ev(`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "abort", id: `p754-abort-${abortT}` })})`);
				summary.timeouts.push({ promptIndex: i, capMs: TURN_CAP_MS, abortedAt: iso(abortT) });
				const after = await waitTurn(log, tabId, abortT - 1);
				entry.endedAt = after.ended ? iso(after.endT) : null;
			} else {
				entry.endedAt = iso(turn.endT);
			}
			summary.promptLog.push(entry);
		}
		await approvalChain;

		// 8. tool cards
		await log.drain();
		const starts = [];
		const seenIds = new Set();
		for (const e of log.forTab(tabId)) {
			if (e.f.type !== "tool_execution_start" || seenIds.has(e.f.toolCallId)) continue;
			seenIds.add(e.f.toolCallId);
			starts.push(e.f);
		}
		for (let n = 0; n < starts.length; n++) {
			summary.cards.push(await captureCard(cdp, dir, tabId, starts[n], n + 1));
		}
	} catch (err) {
		summary.errors.push(String(err?.stack ?? err));
	} finally {
		await Promise.allSettled(background);
		await log.stop();
		cdp.close();
		const endedAt = iso();
		summary.endedAt = endedAt;
		summary.mainLogWindow.to = endedAt;
		Object.assign(summary, deriveCalls(log, tabId));
		const vias = new Set(summary.approvalLog.map((a) => a.via));
		summary.approvalVia = vias.size === 0 ? null : vias.size === 1 ? [...vias][0] : "mixed";
		writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

		// 10. reset the project worktree
		if (flags.project && projectPath) {
			try {
				resetProject(projectPath);
				summary.projectReset = iso();
			} catch (err) {
				summary.errors.push(`project reset: ${err.message}`);
			}
			writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
		}
	}
	process.stdout.write(
		`${JSON.stringify({ id, dir, tabId: summary.tabId, calls: summary.calls.length, approvals: summary.approvals, timeouts: summary.timeouts.length, errors: summary.errors }, null, 2)}\n`,
	);
}

async function clickNewSessionProbe(cdp, projectPath) {
	return cdp.ev(`[...document.querySelectorAll("section button[aria-expanded][title]")]
		.some((b) => b.getAttribute("title") === ${js(projectPath)})`);
}

/**
 * The renderer's boot canary is a get_state response (rpc-command.ts:709-711): it follows the new
 * process's `ready` frame (frame-reduction.ts:438-440 -> bootRpcTab). Waiting for it FIRST matters on a
 * relaunch, where the old process's still-enabled composer would otherwise read as ready.
 */
async function waitReady(cdp, log, tabId, sinceT, phase, summary) {
	const state = await waitFor(
		() =>
			log
				.forTab(tabId)
				.find((e) => e.t > sinceT && e.f.type === "response" && e.f.command === "get_state" && e.f.success !== false) ??
			null,
		60_000,
	);
	const composer = await waitFor(async () => {
		const s = await composerState(cdp, tabId);
		return s.present && !s.disabled ? s : null;
	}, 90_000);
	summary.readiness = summary.readiness ?? [];
	summary.readiness.push({
		phase,
		composerReady: composer !== null,
		getStateAt: state ? iso(state.t) : null,
		settledAt: iso(),
	});
	if (!composer) throw new Error(`${phase}: composer never became ready (is the project's default mode rpc-ui?)`);
	await sleep(1_500);
}

async function waitPlanOn(log, tabId, sinceT) {
	return waitFor(
		() =>
			log.forTab(tabId).find((e) => {
				const f = e.f;
				if (e.t <= sinceT || f.type !== "extension_ui_request" || f.method !== "setStatus") return false;
				if (f.statusKey !== "omp-ui:plan") return false;
				try {
					return JSON.parse(f.statusText).enabled === true;
				} catch {
					return false;
				}
			}) ?? null,
		5_000,
	);
}

async function handleApproval(cdp, dir, tabId, frame, n, summary) {
	const title = String(frame.title);
	const tool = (/^Allow tool: (.+)$/.exec(title.split("\n")[0])?.[1] ?? "unknown").trim();
	summary.approvals[tool] = (summary.approvals[tool] ?? 0) + 1;
	const cardExpr = `${tabSel(tabId)}?.querySelector("[data-approval-card]")`;
	const rect = await waitFor(() => rectOf(cdp, cardExpr), 5_000);
	const entry = { n, tool, requestId: frame.id, at: iso(), via: null, screenshot: null };
	if (rect) {
		entry.screenshot = await screenshot(cdp, join(dir, `approval-${n}.png`), rect).catch((err) => {
			summary.errors.push(`approval ${n} screenshot: ${err.message}`);
			return null;
		});
		const clicked = await cdp.ev(`(() => {
			const card = ${cardExpr};
			if (!card) return null;
			const buttons = [...card.querySelectorAll("button")];
			const allow = buttons.find((b) => b.textContent.trim() === "Allow") ?? buttons.at(-1);
			if (!allow) return null;
			allow.click();
			return { label: allow.textContent.trim(), cardTool: card.querySelector("span[title]")?.title ?? null };
		})()`);
		if (clicked) {
			entry.via = "click";
			entry.clicked = clicked;
		}
	}
	if (!entry.via) {
		await cdp.ev(
			`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "extension_ui_response", id: frame.id, value: "Approve" })})`,
		);
		entry.via = "rpcSend";
	}
	summary.approvalLog.push(entry);
}

async function handlePlanReview(cdp, dir, tabId, frame, summary, promptIndex) {
	const n = summary.dialogs.length + 1;
	const entry = { n, kind: "plan-review", requestId: frame.id, promptIndex, at: iso(), screenshot: null, action: null };
	summary.dialogs.push(entry);
	await sleep(1_500);
	entry.screenshot = await screenshot(cdp, join(dir, `dialog-${n}-plan-review.png`)).catch(() => null);
	await sleep(PLAN_REVIEW_ABORT_MS);
	await cdp.ev(`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "abort", id: `p754-abort-review-${Date.now()}` })})`);
	entry.action = { abort: iso() };
}

async function handleDialog(cdp, dir, tabId, frame, summary, promptIndex) {
	const n = summary.dialogs.length + 1;
	const entry = {
		n,
		kind: frame.method,
		requestId: frame.id,
		title: String(frame.title ?? "").slice(0, 500),
		promptIndex,
		at: iso(),
		screenshot: null,
		action: null,
	};
	summary.dialogs.push(entry);
	await sleep(1_000);
	entry.screenshot = await screenshot(cdp, join(dir, `dialog-${n}.png`)).catch(() => null);
	await sleep(DIALOG_CANCEL_MS);
	await cdp.ev(
		`window.ompBackend.rpcSend(${js(tabId)}, ${js({ type: "extension_ui_response", id: frame.id, cancelled: true })})`,
	);
	entry.action = { cancelledAfterMs: DIALOG_CANCEL_MS, at: iso() };
}

function runProbe(dir, label, summary) {
	return new Promise((resolveP) => {
		const logFile = join(dir, "obsidian-probe.log");
		const fd = openSync(logFile, "a");
		const startedAt = iso();
		const child = spawn(process.execPath, [join(SCRIPT_DIR, "handoff-probe.mjs"), "append-snap", label], {
			cwd: SCRIPT_DIR,
			stdio: ["ignore", fd, fd],
		});
		child.on("close", (code) => {
			closeSync(fd);
			summary.obsidianProbes.push({ label, startedAt, endedAt: iso(), code });
			resolveP();
		});
		child.on("error", (err) => {
			summary.errors.push(`probe ${label}: ${err.message}`);
		});
	});
}

async function captureCard(cdp, dir, tabId, start, n) {
	const id = start.toolCallId;
	const name = String(start.toolName ?? "tool").replace(/[^\w.-]/g, "_");
	// Rows are keyed `tool-<seq>` (renderer sequence), not toolCallId: take the
	// n-th top-level tool row of the tab, which follows tool_execution_start order.
	const wrap = `[...(${tabSel(tabId)}?.querySelectorAll('[data-item-id^="tool-"]') ?? [])][${n - 1}]`;
	const entry = { n, toolCallId: id, toolName: start.toolName, collapsed: null, expanded: null, note: null };
	const scrolled = await cdp.ev(`(() => {
		const el = ${wrap};
		if (!el) return false;
		el.scrollIntoView({ block: "start" });
		return true;
	})()`);
	if (!scrolled) {
		entry.note = "row not in DOM";
		return entry;
	}
	const isOpen = () =>
		cdp.ev(`(() => {
			const h = ${wrap}?.querySelector("button");
			return !!h && !!h.parentElement.querySelector(":scope > .border-t");
		})()`);
	const toggle = () => cdp.ev(`(() => { const h = ${wrap}?.querySelector("button"); if (h) h.click(); return !!h; })()`);
	const shoot = async (suffix) => {
		await sleep(400);
		await cdp.ev(`${wrap}?.scrollIntoView({ block: "start" })`);
		await sleep(200);
		const rect = await rectOf(cdp, wrap);
		if (!rect) return null;
		return screenshot(cdp, join(dir, `card-${n}-${name}-${suffix}.png`), rect);
	};
	entry.initiallyOpen = await isOpen();
	if (entry.initiallyOpen) await toggle();
	entry.collapsed = await shoot("collapsed");
	await toggle();
	entry.expanded = await shoot("expanded");
	entry.expandedOpen = await isOpen();
	return entry;
}

function deriveCalls(log, tabId) {
	if (!tabId) return { calls: [], finalAssistantText: null };
	const frames = log.forTab(tabId);
	const calls = new Map();
	let finalAssistantText = null;
	for (const { t, f } of frames) {
		if (f.type === "tool_execution_start" && !calls.has(f.toolCallId)) {
			calls.set(f.toolCallId, {
				toolCallId: f.toolCallId,
				toolName: f.toolName,
				args: f.args,
				startT: t,
				endT: null,
				e2eMs: null,
				isError: null,
				resultTextPreview: null,
			});
		} else if (f.type === "tool_execution_end") {
			const c = calls.get(f.toolCallId) ?? {
				toolCallId: f.toolCallId,
				toolName: f.toolName,
				args: undefined,
				startT: null,
			};
			c.endT = t;
			c.e2eMs = c.startT === null ? null : t - c.startT;
			c.isError = f.isError === true;
			c.resultTextPreview = textFromContent(f.result?.content).slice(0, 500);
			calls.set(f.toolCallId, c);
		} else if (f.type === "message_end" && f.message?.role === "assistant") {
			const text = textFromContent(f.message.content);
			if (text !== "") finalAssistantText = text;
		}
	}
	return { calls: [...calls.values()], finalAssistantText };
}

function resetProject(projectPath) {
	const abs = resolve(projectPath);
	// Never clean a checkout that contains this prototype's untracked evidence.
	if (PROTO_DIR === abs || PROTO_DIR.startsWith(`${abs}/`)) {
		throw new Error(`refusing to reset ${abs}: it contains ${PROTO_DIR}`);
	}
	execFileSync("git", ["-C", abs, "checkout", "--", "."], { stdio: ["ignore", "inherit", "inherit"] });
	execFileSync("git", ["-C", abs, "clean", "-fd"], { stdio: ["ignore", "inherit", "inherit"] });
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) flags[key] = true;
			else {
				flags[key] = next;
				i++;
			}
		} else positional.push(a);
	}
	return { flags, positional };
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const { flags, positional } = parseArgs(rest);
	const port = Number(flags.port ?? 9754);
	switch (cmd) {
		case "run":
			if (!positional[0]) throw new Error("usage: drive.mjs run <id> [--project <path>] [--port 9754]");
			await run(positional[0], flags);
			break;
		case "eval": {
			if (!positional[0]) throw new Error("usage: drive.mjs eval '<js>' [--port 9754]");
			const { cdp } = await connect(port);
			try {
				process.stdout.write(`${JSON.stringify(await cdp.ev(positional[0]), null, 2)}\n`);
			} finally {
				cdp.close();
			}
			break;
		}
		case "close-tab": {
			if (!positional[0]) throw new Error("usage: drive.mjs close-tab <tabId> [--port 9754]");
			const { cdp } = await connect(port);
			try {
				await cdp.ev(`window.ompBackend.terminateSession(${js(positional[0])})`);
				process.stdout.write(`terminated ${positional[0]}\n`);
			} finally {
				cdp.close();
			}
			break;
		}
		case "cards": {
			// Recapture tool-card stills for a finished run whose tab is still the visible one.
			if (!positional[0]) throw new Error("usage: drive.mjs cards <id> [--port 9754]");
			const dir = join(PROTO_DIR, "evidence/runs", positional[0]);
			const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
			const seen = new Set();
			const starts = [];
			for (const line of readFileSync(join(dir, "frames.jsonl"), "utf8").split("\n")) {
				if (line === "") continue;
				const { tabId, f } = JSON.parse(line);
				if (tabId !== summary.tabId || f.type !== "tool_execution_start" || seen.has(f.toolCallId)) continue;
				seen.add(f.toolCallId);
				starts.push(f);
			}
			const { cdp } = await connect(port);
			try {
				summary.cards = [];
				for (let n = 0; n < starts.length; n++) {
					summary.cards.push(await captureCard(cdp, dir, summary.tabId, starts[n], n + 1));
				}
			} finally {
				cdp.close();
			}
			writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
			process.stdout.write(`${JSON.stringify(summary.cards.map((c) => [c.n, c.toolName, c.note, !!c.collapsed]))}\n`);
			break;
		}
		default:
			throw new Error("usage: drive.mjs <run|eval|close-tab> ...");
	}
}

main().catch((err) => {
	console.error(err?.stack ?? String(err));
	process.exit(1);
});
