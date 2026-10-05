// PROTOTYPE (#754): throwaway.
// Probes how omp-ui could hand a vault note off to the running Obsidian on Linux.
//
// Usage:
//   node handoff-probe.mjs case <H1|H2|H3|H4|H5> --target "omp-ui/Foo.md" [--other "omp-ui/Bar.md"] [--active-timeout-ms 15000]
//   node handoff-probe.mjs ensure-running
//   node handoff-probe.mjs open <vault-relative path>
//   node handoff-probe.mjs toggle-preview
//   node handoff-probe.mjs snap <label>          (alias of append-snap)
//   node handoff-probe.mjs append-snap <label>
//
// Evidence: ../evidence/handoff/<case>.json, ../evidence/obsidian/<label>.png, ../evidence/obsidian/append-snaps.jsonl
//
// Observed Obsidian CLI (1.14.4) output formats:
//   eval   -> "=> <value>" (objects pretty-printed JSON, strings raw, multi-line raw);
//             undefined -> "(no output)"; thrown error -> "Error: <msg>"; exit code is 0 in all cases.
//   dev:dom selector=X text all -> one match per line; "No elements found." when none.
//   dev:screenshot path=<p> -> prints the absolute output path; relative paths resolve against the VAULT ROOT.
//   command id=<bad> -> "Error: Command "<id>" not found. ..." with exit 0.
//   vault=<unknown> -> "Vault not found." with exit 0.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OBSIDIAN_CLI = "/home/alankford/.local/bin/obsidian";
const VAULT_NAME = "Obsidian";
const VAULT_ID = "ee8bdab8baa42089";
const OMP_UI_PATH = "/home/alankford/.local/share/omp-ui/bin:/home/alankford/.cargo/bin:/usr/local/bin:/usr/bin";
const SOCKET_PATH = join(process.env.XDG_RUNTIME_DIR || "/run/user/1000", ".obsidian-cli.sock");
// Main Electron process of the AppImage: /tmp/.mount_ObsidiXXXX/obsidian [args] without --type=.
const MAIN_PID_PATTERN = String.raw`\.mount_[^/ ]*/obsidian( |$)`;
const NEEDLE = "Confirmed on 2026-10-05";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(SCRIPT_DIR, "..", "evidence");
const HANDOFF_DIR = join(EVIDENCE_DIR, "handoff");
const OBSIDIAN_DIR = join(EVIDENCE_DIR, "obsidian");

const CHILD_ENV = { PATH: OMP_UI_PATH };
for (const key of ["HOME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
	if (process.env[key] !== undefined) CHILD_ENV[key] = process.env[key];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

/** Spawn argv (no shell), stdin ignored. Never rejects. */
function run(argv, { timeoutMs = 20000 } = {}) {
	return new Promise((resolvePromise) => {
		const started = now();
		let stdout = "";
		let stderr = "";
		let errorCode = null;
		let errorMessage = null;
		let settled = false;
		let child;
		const finish = (exitCode, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({
				argv,
				exitCode,
				signal,
				stdout,
				stderr,
				errorCode,
				errorMessage,
				ms: Math.round(now() - started),
			});
		};
		try {
			child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV });
		} catch (err) {
			errorCode = err.code ?? null;
			errorMessage = String(err.message ?? err);
			finish(null, null);
			return;
		}
		const timer = setTimeout(() => {
			errorCode = "PROBE_TIMEOUT";
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (err) => {
			errorCode = err.code ?? errorCode;
			errorMessage = String(err.message ?? err);
			finish(null, null);
		});
		child.on("close", (code, signal) => finish(code, signal));
	});
}

const cli = (...args) => run([OBSIDIAN_CLI, `vault=${VAULT_NAME}`, ...args]);

/** Strip the CLI's "=> " prefix; "(no output)" -> undefined. Returns {ok, value, raw}. */
function parseEvalOutput(res) {
	const raw = res.stdout.replace(/\n$/, "");
	if (res.errorCode || res.exitCode !== 0) return { ok: false, value: undefined, raw: raw || res.stderr };
	if (raw === "(no output)") return { ok: true, value: undefined, raw };
	if (raw.startsWith("=> ")) return { ok: true, value: raw.slice(3), raw };
	return { ok: false, value: undefined, raw };
}

/** Evaluate expression in Obsidian; result transported via JSON.stringify so types survive. */
async function evalJson(expr) {
	const res = await cli("eval", `code=JSON.stringify({v:(${expr})})`);
	const parsed = parseEvalOutput(res);
	if (!parsed.ok || parsed.value === undefined) return { ok: false, value: undefined, raw: parsed.raw, ms: res.ms };
	try {
		return { ok: true, value: JSON.parse(parsed.value).v, raw: parsed.raw, ms: res.ms };
	} catch {
		return { ok: false, value: undefined, raw: parsed.raw, ms: res.ms };
	}
}

const activeFilePath = () => evalJson("app.workspace.getActiveFile()?.path ?? null");

async function pollActiveFile(target, capMs) {
	const started = now();
	let lastSeen;
	let lastRaw;
	let polls = 0;
	while (now() - started < capMs) {
		polls++;
		const r = await activeFilePath();
		lastSeen = r.value;
		lastRaw = r.raw;
		if (r.ok && r.value === target) {
			return { matched: true, ms: Math.round(now() - started), lastSeen, polls };
		}
		await sleep(100);
	}
	return { matched: false, ms: null, lastSeen, lastRaw, polls, capMs };
}

// ---------- process inspection ----------

function readProcStat(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const open = stat.indexOf("(");
		const close = stat.lastIndexOf(")");
		const comm = stat.slice(open + 1, close);
		const ppid = Number(stat.slice(close + 2).split(" ")[1]);
		return { pid, comm, ppid };
	} catch {
		return null;
	}
}

function procArgs(pid) {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

async function findObsidianMain() {
	const res = await run(["pgrep", "-f", MAIN_PID_PATTERN]);
	const pids = res.stdout.split("\n").filter(Boolean).map(Number);
	const candidates = [];
	for (const pid of pids) {
		const args = procArgs(pid);
		const stat = readProcStat(pid);
		if (!args || !stat) continue;
		if (args.some((a) => a.startsWith("--type="))) continue;
		candidates.push({ pid, ppid: stat.ppid, comm: stat.comm, args0: args[0] });
	}
	const candidatePids = new Set(candidates.map((c) => c.pid));
	const isObsidianParent = (c) => {
		const parent = readProcStat(c.ppid);
		return candidatePids.has(c.ppid) || (parent && /obsidian/i.test(parent.comm) && !/AppIma/i.test(parent.comm));
	};
	const main = candidates.find((c) => !isObsidianParent(c)) ?? candidates[0] ?? null;
	return { pattern: MAIN_PID_PATTERN, candidates, mainPid: main?.pid ?? null };
}

async function findAppImageRuntime() {
	const res = await run(["pgrep", "-f", String.raw`Obsidian\.AppImage`]);
	return res.stdout.split("\n").filter(Boolean).map(Number);
}

/** ppid via `ps`, its comm, and whether the probe is an ancestor. */
async function describeParentage(pid) {
	if (!pid) return null;
	const ps = await run(["ps", "-o", "ppid=", "-p", String(pid)]);
	const ppid = Number(ps.stdout.trim()) || null;
	let ppidComm = null;
	if (ppid) {
		const c = await run(["ps", "-o", "comm=", "-p", String(ppid)]);
		ppidComm = c.stdout.trim() || null;
	}
	const chain = [];
	let cur = readProcStat(pid);
	let probeIsAncestor = false;
	for (let i = 0; cur && i < 64; i++) {
		chain.push({ pid: cur.pid, comm: cur.comm });
		if (cur.ppid === process.pid) probeIsAncestor = true;
		if (cur.ppid <= 1) {
			if (cur.ppid === 1) chain.push({ pid: 1, comm: readProcStat(1)?.comm ?? null });
			break;
		}
		cur = readProcStat(cur.ppid);
	}
	return {
		pid,
		ppid,
		ppidComm,
		ppidIsProbe: ppid === process.pid,
		probeIsAncestor,
		ancestry: chain,
	};
}

// ---------- obsidian lifecycle ----------

async function isResponsive() {
	if (!existsSync(SOCKET_PATH)) return false;
	const r = await cli("vault", "info=name");
	return r.exitCode === 0 && r.stdout.trim() === VAULT_NAME;
}

async function ensureRunning({ capMs = 30000 } = {}) {
	const started = now();
	const before = await findObsidianMain();
	const out = { socketPath: SOCKET_PATH, socketBefore: existsSync(SOCKET_PATH), mainPidBefore: before.mainPid };
	if (before.mainPid && (await isResponsive())) {
		return { ...out, alreadyRunning: true, ready: true, ms: Math.round(now() - started) };
	}
	out.alreadyRunning = false;
	out.launch = await run(["setsid", "-f", "xdg-open", `obsidian://open?vault=${VAULT_ID}`]);
	while (now() - started < capMs) {
		if ((await findObsidianMain()).mainPid && (await isResponsive())) {
			out.ready = true;
			out.ms = Math.round(now() - started);
			out.mainPidAfter = (await findObsidianMain()).mainPid;
			return out;
		}
		await sleep(250);
	}
	out.ready = false;
	out.ms = Math.round(now() - started);
	return out;
}

async function ensureQuit({ capMs = 15000 } = {}) {
	const started = now();
	const before = await findObsidianMain();
	const runtimes = await findAppImageRuntime();
	const out = {
		mainPid: before.mainPid,
		appImageRuntimePids: runtimes,
		socketBefore: existsSync(SOCKET_PATH),
	};
	if (before.mainPid) {
		try {
			process.kill(before.mainPid, "SIGTERM");
			out.sigterm = "sent";
		} catch (err) {
			out.sigterm = `failed: ${err.code ?? err.message}`;
		}
	} else {
		out.sigterm = "skipped: not running";
	}
	let pidGoneMs = null;
	let socketGoneMs = null;
	while (now() - started < capMs) {
		const t = Math.round(now() - started);
		if (pidGoneMs === null && (!before.mainPid || !existsSync(`/proc/${before.mainPid}`))) pidGoneMs = t;
		if (socketGoneMs === null && !existsSync(SOCKET_PATH)) socketGoneMs = t;
		if (pidGoneMs !== null && socketGoneMs !== null) break;
		await sleep(100);
	}
	out.pidGoneMs = pidGoneMs;
	out.socketGoneMs = socketGoneMs;
	out.quitComplete = pidGoneMs !== null && socketGoneMs !== null;
	out.appImageRuntimeAliveAfter = runtimes.filter((p) => existsSync(`/proc/${p}`));
	out.ms = Math.round(now() - started);
	return out;
}

// ---------- snapshots ----------

async function screenshot(label) {
	mkdirSync(OBSIDIAN_DIR, { recursive: true });
	const abs = join(OBSIDIAN_DIR, `${label}.png`);
	const r = await cli("dev:screenshot", `path=${abs}`);
	return { path: abs, exists: existsSync(abs), stdout: r.stdout.trim(), exitCode: r.exitCode, ms: r.ms };
}

async function notices() {
	const r = await cli("dev:dom", "selector=.notice", "text", "all");
	const raw = r.stdout.replace(/\n$/, "");
	return { raw, items: raw === "No elements found." || raw === "" ? [] : raw.split("\n"), exitCode: r.exitCode };
}

// No backslashes in this code: the CLI documents \n/\t escape handling for values.
const EDITOR_STATE_EXPR = `(() => {
	const ws = app.workspace;
	const al = ws.activeLeaf;
	const rl = ws.getMostRecentLeaf ? ws.getMostRecentLeaf() : null;
	const ed = ws.activeEditor?.editor;
	const needle = ${JSON.stringify(NEEDLE)};
	const count = (s) => (typeof s === "string" ? s.split(needle).length - 1 : null);
	const value = ed?.getValue?.();
	const rvActive = document.querySelector(".workspace-leaf.mod-active .markdown-reading-view");
	const rvRecent = rl?.view?.containerEl?.querySelector(".markdown-reading-view");
	const visible = (el) => (el ? el.offsetParent !== null && getComputedStyle(el).display !== "none" : null);
	return {
		activeFile: ws.getActiveFile()?.path ?? null,
		activeLeafViewType: al?.view?.getViewType?.() ?? null,
		activeLeafMode: al?.view?.getMode?.() ?? null,
		recentLeafViewType: rl?.view?.getViewType?.() ?? null,
		recentLeafFile: rl?.view?.file?.path ?? null,
		recentLeafMode: rl?.view?.getMode?.() ?? null,
		recentLeafEphemeral: rl?.view?.getEphemeralState?.() ?? null,
		cursor: ed?.getCursor?.() ?? null,
		scrollInfo: ed?.getScrollInfo?.() ?? null,
		editorLength: typeof value === "string" ? value.length : null,
		editorNeedleCount: count(value),
		readingViewActive: { present: !!rvActive, visible: visible(rvActive), needleCount: count(rvActive?.innerText) },
		readingViewRecentLeaf: { present: !!rvRecent, visible: visible(rvRecent), needleCount: count(rvRecent?.innerText) },
		documentHasFocus: document.hasFocus(),
	};
})()`;

async function editorState() {
	const r = await evalJson(EDITOR_STATE_EXPR);
	return r.ok ? r.value : { error: r.raw };
}

async function appendSnap(label) {
	const entry = {
		timestamp: new Date().toISOString(),
		label,
		screenshot: await screenshot(label),
		notices: await notices(),
		state: await editorState(),
	};
	mkdirSync(OBSIDIAN_DIR, { recursive: true });
	appendFileSync(join(OBSIDIAN_DIR, "append-snaps.jsonl"), `${JSON.stringify(entry)}\n`);
	return entry;
}

async function focusState() {
	const doc = await evalJson("document.hasFocus()");
	const win = await evalJson("require('electron').remote.getCurrentWindow().isFocused()");
	return { documentHasFocus: doc.ok ? doc.value : { error: doc.raw }, windowIsFocused: win.ok ? win.value : { error: win.raw } };
}

// ---------- open / toggle helpers ----------

async function openAndWait(path, capMs = 15000) {
	const res = await cli("open", `path=${path}`);
	const poll = await pollActiveFile(path, capMs);
	return { command: res, poll };
}

async function togglePreview() {
	const before = await evalJson("app.workspace.activeLeaf?.view?.getMode?.() ?? null");
	const res = await cli("command", "id=markdown:toggle-preview");
	await sleep(200);
	const after = await evalJson("app.workspace.activeLeaf?.view?.getMode?.() ?? null");
	return { modeBefore: before.value ?? null, command: res, modeAfter: after.value ?? null };
}

// ---------- cases ----------

const CASES = {
	H1: { needs: "running", via: "cli" },
	H2: { needs: "quit", via: "cli" },
	H3: { needs: "running", via: "uri" },
	H4: { needs: "quit", via: "uri" },
	H5: { needs: "running", via: "bare-cli" },
};

function handoffArgv(via, target) {
	if (via === "cli") return [OBSIDIAN_CLI, `vault=${VAULT_NAME}`, "open", `path=${target}`];
	if (via === "uri") {
		const file = encodeURIComponent(target.replace(/\.md$/, ""));
		return ["setsid", "-f", "xdg-open", `obsidian://open?vault=${VAULT_ID}&file=${file}`];
	}
	return ["obsidian", "open", `path=${target}`];
}

async function runCase(name, { target, other, activeTimeoutMs }) {
	const spec = CASES[name];
	if (!spec) throw new Error(`unknown case ${name}; expected one of ${Object.keys(CASES).join(", ")}`);
	if (!target) throw new Error("--target is required");
	const evidence = {
		case: name,
		startedAt: new Date().toISOString(),
		probePid: process.pid,
		target,
		other: other ?? null,
		spec,
		childEnvPath: CHILD_ENV.PATH,
		socketPath: SOCKET_PATH,
	};

	if (spec.needs === "running") {
		evidence.ensureRunning = await ensureRunning();
		if (other) evidence.openOther = await openAndWait(other, activeTimeoutMs);
	} else {
		evidence.ensureQuit = await ensureQuit();
	}
	evidence.activeFileBefore = (await activeFilePath()).value ?? null;
	evidence.mainBefore = await findObsidianMain();
	evidence.parentageBefore = await describeParentage(evidence.mainBefore.mainPid);

	const argv = handoffArgv(spec.via, target);
	const res = await run(argv);
	evidence.handoff = {
		argv,
		exitCode: res.exitCode,
		signal: res.signal,
		stdout: res.stdout,
		stderr: res.stderr,
		errorCode: res.errorCode,
		errorMessage: res.errorMessage,
		commandReturnMs: res.ms,
	};

	const poll = await pollActiveFile(target, activeTimeoutMs);
	evidence.activeFileMs = poll.ms;
	evidence.activeFilePoll = poll;
	evidence.focus = await focusState();
	evidence.mainAfter = await findObsidianMain();
	evidence.mainPidChanged = evidence.mainBefore.mainPid !== evidence.mainAfter.mainPid;
	evidence.parentageAfter = await describeParentage(evidence.mainAfter.mainPid);
	evidence.screenshot = await screenshot(name);
	evidence.finishedAt = new Date().toISOString();

	mkdirSync(HANDOFF_DIR, { recursive: true });
	const outPath = join(HANDOFF_DIR, `${name}.json`);
	writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
	return { written: outPath, evidence };
}

// ---------- CLI ----------

function parseFlags(args) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) flags[a.slice(2)] = args[++i];
		else positional.push(a);
	}
	return { flags, positional };
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	const { flags, positional } = parseFlags(rest);
	let result;
	switch (cmd) {
		case "case":
			result = await runCase(positional[0], {
				target: flags.target,
				other: flags.other,
				activeTimeoutMs: Number(flags["active-timeout-ms"] ?? 15000),
			});
			break;
		case "ensure-running":
			result = await ensureRunning();
			break;
		case "open":
			if (!positional[0]) throw new Error("usage: open <vault-relative path>");
			result = await openAndWait(positional[0]);
			break;
		case "toggle-preview":
			result = await togglePreview();
			break;
		case "snap":
		case "append-snap":
			if (!positional[0]) throw new Error(`usage: ${cmd} <label>`);
			result = await appendSnap(positional[0]);
			break;
		default:
			throw new Error("usage: handoff-probe.mjs <case|ensure-running|open|toggle-preview|snap|append-snap> ...");
	}
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
	process.stderr.write(`${err.stack ?? err}\n`);
	process.exit(1);
});
