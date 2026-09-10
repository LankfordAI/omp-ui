import type { HostBootstrapStatus } from "@omp-ui/core/host-bootstrap-channels";
import { IncompatibleHostError } from "./remote-backend";

// Raw-DOM surfaces shared by both boot shims (web/main.web.tsx and renderer/src/main.tsx). They
// run before — or instead of — the React app, so they must not depend on the renderer, its
// stylesheet, or React, any of which could be the thing that failed (issue #442 §11).

const COPY = {
  en: {
    connectFailure: "omp-ui could not connect",
    recoveryTitle: "omp-ui could not reach its host",
    noBootstrap: "This page has no host bootstrap — it only runs inside the omp-ui desktop client.",
    retry: "Retry",
    stopHost: "Stop host",
    rollback: "Roll back to {version}",
    reconnecting: "reconnecting to omp-ui…",
    sessionEnded: "session ended — tap to sign in again",
    phase: {
      probing: "looking for the host…",
      installing: "installing the host…",
      starting: "starting the host…",
      ready: "host ready",
      failed: "host unavailable",
    },
    dataRoot: "Data root",
    clientLogDir: "Client logs",
    hostLogDir: "Host logs",
    hostVersion: "Host version",
    hostPid: "Host PID",
    supervisor: "Supervisor",
  },
  ko: {
    connectFailure: "omp-ui에 연결할 수 없습니다",
    recoveryTitle: "omp-ui가 호스트에 연결할 수 없습니다",
    noBootstrap: "이 페이지에는 호스트 부트스트랩이 없습니다. omp-ui 데스크톱 클라이언트 안에서만 실행됩니다.",
    retry: "다시 시도",
    stopHost: "호스트 중지",
    rollback: "{version}(으)로 롤백",
    reconnecting: "omp-ui에 다시 연결하는 중…",
    sessionEnded: "세션이 종료되었습니다. 탭하여 다시 로그인하세요",
    phase: {
      probing: "호스트를 찾는 중…",
      installing: "호스트를 설치하는 중…",
      starting: "호스트를 시작하는 중…",
      ready: "호스트 준비됨",
      failed: "호스트를 사용할 수 없음",
    },
    dataRoot: "데이터 루트",
    clientLogDir: "클라이언트 로그",
    hostLogDir: "호스트 로그",
    hostVersion: "호스트 버전",
    hostPid: "호스트 PID",
    supervisor: "슈퍼바이저",
  },
} as const;

type Copy = (typeof COPY)["en"] | (typeof COPY)["ko"];

/** The renderer persists its locale here (lib/i18n); this runs before the renderer can be trusted. */
export function bootCopy(): Copy {
  try {
    return localStorage.getItem("omp-ui.localeId") === "ko" ? COPY.ko : COPY.en;
  } catch {
    return COPY.en;
  }
}

const BOX_STYLE =
  "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;" +
  "height:100dvh;background:#0a0b0d;color:#c8d0da;font:14px/1.5 system-ui,sans-serif;padding:24px;text-align:center";
const TITLE_STYLE = "margin:0;font-size:15px;font-weight:600;color:#e6ebf2";
const DETAIL_STYLE = "margin:0;max-width:36rem;color:#8b95a3";
const BUTTON_STYLE =
  "border:1px solid #2a3038;background:#14171b;color:#c8d0da;border-radius:4px;padding:4px 12px;cursor:pointer;font:inherit";
const TABLE_STYLE = "border-collapse:collapse;font:12px/1.6 ui-monospace,monospace;color:#8b95a3;text-align:left";
const TABLE_KEY_STYLE = "padding:0 12px 0 0;color:#5f6975;white-space:nowrap;vertical-align:top";
const TABLE_VALUE_STYLE = "padding:0;color:#c8d0da;word-break:break-all;user-select:text";

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.style.cssText = BUTTON_STYLE;
  el.addEventListener("click", onClick);
  return el;
}

function clearedRoot(): HTMLElement | null {
  const root = document.getElementById("root");
  if (root) root.innerHTML = "";
  return root;
}

/** One line for a failed connect: an incompatible verdict names the host version; anything else is its own message. */
export function connectFailureMessage(err: unknown): string {
  if (err instanceof IncompatibleHostError) {
    return err.hostVersion === "" ? err.message : `${err.message} (omp-ui ${err.hostVersion})`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Fallback for a failed connect: the message and one retry action (a reload unless told otherwise). */
export function renderConnectFailure(message: string, retry: () => void = () => location.reload()): void {
  const root = clearedRoot();
  if (!root) return;
  const c = bootCopy();
  const box = document.createElement("div");
  box.style.cssText = BOX_STYLE;
  const title = document.createElement("h1");
  title.textContent = c.connectFailure;
  title.style.cssText = TITLE_STYLE;
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = DETAIL_STYLE;
  box.append(title, detail, button(c.retry, retry));
  root.append(box);
}

export interface HostRecoveryActions {
  retry(): void;
  stop(): void;
  rollback(): void;
}

/**
 * The desktop client's recovery surface (issue #442 §11): what the bootstrap knows about the
 * host — phase, message, data root, both log directories, version/pid/supervisor — plus the
 * three actions it offers. Returns the updater to feed `HostBootstrap.onStatus` so the text
 * follows a retry as it runs; `message` overrides the status message for the first paint (an
 * incompatible verdict, for instance, is the connection's failure, not the bootstrap's).
 */
export function renderHostRecovery(
  status: HostBootstrapStatus,
  message: string | null,
  actions: HostRecoveryActions,
): (next: HostBootstrapStatus) => void {
  const root = clearedRoot();
  if (!root) return () => {};
  const c = bootCopy();
  const box = document.createElement("div");
  box.style.cssText = BOX_STYLE;
  const title = document.createElement("h1");
  title.textContent = c.recoveryTitle;
  title.style.cssText = TITLE_STYLE;
  const phase = document.createElement("p");
  phase.style.cssText = "margin:0;color:#e6ebf2";
  const detail = document.createElement("p");
  detail.style.cssText = DETAIL_STYLE;

  const table = document.createElement("table");
  table.style.cssText = TABLE_STYLE;
  const rows: Array<[keyof typeof c & string, (s: HostBootstrapStatus) => string]> = [
    ["dataRoot", (s) => s.dataRoot],
    ["clientLogDir", (s) => s.clientLogDir],
    ["hostLogDir", (s) => s.hostLogDir],
    ["hostVersion", (s) => s.hostVersion ?? "—"],
    ["hostPid", (s) => (s.hostPid === null ? "—" : String(s.hostPid))],
    ["supervisor", (s) => s.supervisor ?? "—"],
  ];
  const cells: Array<[HTMLTableCellElement, (s: HostBootstrapStatus) => string]> = [];
  for (const [key, read] of rows) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = c[key] as string;
    th.style.cssText = TABLE_KEY_STYLE;
    const td = document.createElement("td");
    td.style.cssText = TABLE_VALUE_STYLE;
    tr.append(th, td);
    table.append(tr);
    cells.push([td, read]);
  }

  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center";
  const retry = button(c.retry, actions.retry);
  const stop = button(c.stopHost, actions.stop);
  const rollback = button("", actions.rollback);
  buttons.append(retry, stop, rollback);

  box.append(title, phase, detail, table, buttons);
  root.append(box);

  let first = true;
  const update = (s: HostBootstrapStatus): void => {
    phase.textContent = c.phase[s.phase];
    const text = first && message !== null ? message : s.message;
    detail.textContent = text ?? "";
    detail.style.display = text === null || text === "" ? "none" : "";
    for (const [td, read] of cells) td.textContent = read(s);
    // A retry is already one while the bootstrap is mid-flight.
    retry.disabled = s.phase === "probing" || s.phase === "installing" || s.phase === "starting";
    rollback.style.display = s.rollbackVersion === null ? "none" : "";
    if (s.rollbackVersion !== null) rollback.textContent = c.rollback.replace("{version}", s.rollbackVersion);
    first = false;
  };
  update(status);
  return update;
}

/** What a reconnect probe learned: reload on `up`, keep polling on `down`, offer sign-in on `signed-out`. */
export type ProbeResult = "up" | "down" | "signed-out";

/**
 * Fixed strip shown while the socket is down, plus a probe that reloads once the host answers
 * again. A reload rather than an in-place resync is deliberate: bootRpcTab already refetches
 * transcript history from omp, so a reload is a correct and complete resync with no synthetic
 * frames to invent. `signed-out` is the browser's case only — the credential no longer works —
 * and offers the login page instead of waiting forever.
 */
export function mountReconnectBanner(
  onStatus: (cb: (up: boolean) => void) => void,
  probe: () => Promise<ProbeResult>,
): void {
  const host = document.getElementById("remote-banner");
  if (!host) return;
  const strip = document.createElement("div");
  strip.textContent = bootCopy().reconnecting;
  strip.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;padding:calc(4px + env(safe-area-inset-top, 0px)) calc(12px + env(safe-area-inset-right, 0px)) 4px calc(12px + env(safe-area-inset-left, 0px));" +
    "background:#3a2a12;color:#e8c99a;font:12px/1.4 system-ui,sans-serif;text-align:center";
  host.append(strip);

  // Browser setInterval, so a plain number — no Node timer handle in this bundle.
  let timer: number | undefined;
  const stopPolling = (): void => {
    clearInterval(timer);
    timer = undefined;
  };
  onStatus((up) => {
    if (up) {
      strip.style.display = "none";
      stopPolling();
      return;
    }
    strip.textContent = bootCopy().reconnecting;
    strip.style.display = "block";
    if (timer !== undefined) return;
    timer = window.setInterval(() => {
      probe().then(
        (result) => {
          if (result === "up") {
            location.reload();
          } else if (result === "signed-out") {
            strip.textContent = bootCopy().sessionEnded;
            strip.style.cursor = "pointer";
            strip.addEventListener(
              "click",
              () => {
                location.href = "./login";
              },
              { once: true },
            );
            stopPolling();
          }
        },
        () => {
          // Still down — the next tick tries again.
        },
      );
    }, 2_000);
  });
}
