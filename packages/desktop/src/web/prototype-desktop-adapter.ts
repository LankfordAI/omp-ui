// PROTOTYPE (#454) — throwaway. Three variants of the desktop capability adapter on the existing
// web client route, switchable via ?role=desktop|desktop-failing|browser and the bottom bar.
import type { DesktopAdapter } from "@omp-ui/core/desktop-channels";
import type { AppUpdateState } from "@omp-ui/core/types";

export const ROLES = ["desktop", "desktop-failing", "browser"] as const;
export type Role = (typeof ROLES)[number];

export function roleFromLocation(): Role {
  const r = new URLSearchParams(location.search).get("role");
  return (ROLES as readonly string[]).includes(r ?? "") ? (r as Role) : "browser";
}

const log: string[] = [];
const logListeners = new Set<() => void>();
function record(line: string): void {
  log.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (log.length > 8) log.shift();
  for (const cb of logListeners) cb();
}
const show = (v: unknown): string => JSON.stringify(v);

const available: AppUpdateState = {
  status: "available",
  currentVersion: "0.10.6",
  latestVersion: "0.11.0",
  releaseUrl: "https://github.com/LankfordAI/omp-ui/releases",
  releaseName: "v0.11.0",
  format: "appimage",
  progress: null,
  downloadedPath: null,
  installOnQuit: false,
  error: null,
};

export function fakeDesktopAdapter(failing: boolean): DesktopAdapter {
  let update: AppUpdateState = failing
    ? { ...available, status: "idle", latestVersion: null }
    : available;
  const stateCbs: Array<(s: AppUpdateState) => void> = [];
  const set = (patch: Partial<AppUpdateState>): void => {
    update = { ...update, ...patch };
    record(`update → ${update.status}${update.progress === null ? "" : ` ${update.progress}%`}`);
    for (const cb of stateCbs) cb(update);
  };
  const effect = <T,>(name: string, args: unknown[], ok: () => T): Promise<T> => {
    record(`${name}(${args.map(show).join(", ")})`);
    if (failing) {
      record(`  ✗ ${name}: unavailable (prototype)`);
      return Promise.reject(new Error(`${name}: unavailable (prototype)`));
    }
    return Promise.resolve(ok());
  };
  return {
    setWindowChrome: (bg, sym) => effect("setWindowChrome", [bg, sym], () => undefined),
    openPath: (p) => effect("openPath", [p], () => undefined),
    showPathInFolder: (p) => effect("showPathInFolder", [p], () => undefined),
    openExternal: (u) => effect("openExternal", [u], () => undefined),
    getProjectOpenAvailability: () => {
      record("getProjectOpenAvailability()");
      return Promise.resolve(
        failing ? { vsCode: false, terminal: false } : { vsCode: true, terminal: true },
      );
    },
    openProject: (p, t) => effect("openProject", [p, t], () => undefined),
    chooseSavePath: (name, exts) => {
      record(`chooseSavePath(${show(name)}, ${show(exts)})${failing ? "  → null (cancelled)" : ""}`);
      return Promise.resolve(failing ? null : `/tmp/${name}`);
    },
    viewedTab: (tabId) => record(`viewedTab(${show(tabId)})`),
    onSurfaceTab: () => record("onSurfaceTab(cb) subscribed"),
    getAppUpdateState: () => {
      record("getAppUpdateState()");
      return Promise.resolve(update);
    },
    checkAppUpdate: () => {
      record("checkAppUpdate()");
      set(failing ? { status: "error", error: "prototype: feed unreachable" } : { ...available });
      return Promise.resolve(update);
    },
    downloadAppUpdate: () =>
      effect("downloadAppUpdate", [], () => {
        set({ status: "downloading", progress: 0 });
        let pct = 0;
        const timer = setInterval(() => {
          pct += 25;
          if (pct < 100) set({ progress: pct });
          else {
            clearInterval(timer);
            set({
              status: "downloaded",
              progress: null,
              downloadedPath: "/tmp/omp-ui-0.11.0.AppImage",
            });
          }
        }, 500);
      }),
    openAppUpdateReleaseNotes: () => effect("openAppUpdateReleaseNotes", [], () => undefined),
    showAppUpdateDownload: () => effect("showAppUpdateDownload", [], () => undefined),
    restartForAppUpdate: () =>
      effect("restartForAppUpdate", [], () => set({ status: "installing" })),
    setAppUpdateInstallOnQuit: (on) =>
      effect("setAppUpdateInstallOnQuit", [on], () => set({ installOnQuit: on })),
    dismissAppUpdate: (v, remember) =>
      effect("dismissAppUpdate", [v, remember], () => set({ status: "idle" })),
    onAppUpdateState: (cb) => {
      stateCbs.push(cb);
      record("onAppUpdateState(cb) subscribed");
    },
  };
}

/** Fixed bottom-centre pill: ◀ role ▶, adapter presence, last eight effects. Dev-only (see caller). */
export function mountPrototypeBar(role: Role): void {
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;max-width:min(40rem,calc(100vw - 2rem));" +
    "background:#111;color:#eee;border:1px solid #666;border-radius:10px;padding:6px 10px;font:12px/1.4 ui-monospace,monospace;box-shadow:0 4px 16px rgba(0,0,0,.5)";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;justify-content:center";
  const mk = (label: string, delta: number): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "background:#222;color:#eee;border:1px solid #555;border-radius:6px;padding:0 8px;cursor:pointer;font:inherit";
    b.addEventListener("click", () => cycle(delta));
    return b;
  };
  const title = document.createElement("span");
  title.textContent = `PROTOTYPE #454 · role=${role} · ompDesktop ${window.ompDesktop ? "present" : "absent"}`;
  head.append(mk("◀", -1), title, mk("▶", 1));
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:6px 0 0;white-space:pre-wrap;max-height:9rem;overflow:auto;opacity:.9";
  const render = (): void => {
    pre.textContent = log.length === 0 ? "(no client effects yet)" : log.join("\n");
  };
  logListeners.add(render);
  render();
  bar.append(head, pre);
  document.body.append(bar);
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") cycle(-1);
    if (e.key === "ArrowRight") cycle(1);
  });
  function cycle(delta: number): void {
    const next = ROLES[(ROLES.indexOf(role) + delta + ROLES.length) % ROLES.length]!;
    const url = new URL(location.href);
    url.searchParams.set("role", next);
    // The adapter must exist before the renderer imports, so a reload is the switch.
    location.href = url.toString();
  }
}
