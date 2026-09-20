import type { PlanDiagnostic } from "@omp-ui/core/plan";

/** One layout sample's outcome. `inconclusive` can never become `passed`. */
export type LayoutProbeResult =
  | { status: "measured"; diagnostics: PlanDiagnostic[] }
  | {
      status: "inconclusive";
      code: "VERIFIER_TIMEOUT" | "VERIFIER_UNAVAILABLE";
      detail?: string;
    };
export type LayoutProbe = (doc: string, width: number) => Promise<LayoutProbeResult>;

const PROBE_TIMEOUT_MS = 4_000;

/**
 * The settle a sample waits out before it is measured. On a painting page the
 * two animation frames below win in about 33 ms; this timer only takes over
 * when the clock is not ticking at all, and even under a hidden page's ~1 Hz
 * timer alignment it lands an order of magnitude inside PROBE_TIMEOUT_MS.
 */
const PROBE_SETTLE_MS = 250;

// Whether this environment performs real layout. jsdom lays out nothing (all
// rects are zero) and offers no trusted CSSOM constructor path, so a
// layout-less environment resolves inconclusive without creating a frame —
// surfaces then show the document but never claim a layout verdict.
let layoutCapable: boolean | undefined;

function canMeasureLayout(): boolean {
  if (layoutCapable === undefined) {
    const el = document.createElement("div");
    el.textContent = "x";
    el.style.cssText = "position:absolute;left:-10000px;top:0";
    document.body.appendChild(el);
    layoutCapable = el.getBoundingClientRect().height > 0;
    el.remove();
  }
  return layoutCapable;
}

/**
 * Authoritative layout pass (§4, rewritten): loads the prepared document
 * into a hidden, script-less, SAME-ORIGIN probe iframe (measurement channel
 * only — never `allow-scripts`) and measures REAL visible content at a real
 * width:
 *
 *  - nonempty text ranges or drawable SVG/image elements with nonzero client
 *    rects, visible (no hidden ancestor, opacity > 0), nonzero clip areas —
 *    body padding alone does not pass;
 *  - document-level horizontal overflow beyond one CSS pixel fails, while an
 *    explicit scroll container may scroll inside;
 *  - CSP violations and broken embedded data images are resource failures;
 *  - the frame is offscreen but NOT visibility-hidden and NOT opacity-zero —
 *    both inherit into every child and would fail the visibility rule.
 *
 * Waits for the intended document's load, then for a settle that races two
 * animation frames on the PARENT page's clock against PROBE_SETTLE_MS. The
 * hidden child frame's clock may never advance (issue #415) and the parent's
 * stops entirely while the window is hidden (issue #504), so neither is
 * allowed to be the only way out. A timeout, crash, or layout-less
 * environment is inconclusive, never passed.
 */
export const probePlanLayout: LayoutProbe = (doc, width = 800) => {
  if (!canMeasureLayout()) {
    return Promise.resolve({
      status: "inconclusive",
      code: "VERIFIER_UNAVAILABLE",
      detail: "this environment performs no layout",
    });
  }
  const { promise, resolve } = Promise.withResolvers<LayoutProbeResult>();
  const frame = document.createElement("iframe");
  let settled = false;
  const cleanup = (): void => {
    frame.remove();
  };
  const done = (result: LayoutProbeResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    resolve(result);
  };
  // The timeout detail names the phase the probe never left, so a load that
  // never fired is told apart from a measurement that never ran after load.
  let phase: "waiting-for-load" | "waiting-for-settle" = "waiting-for-load";
  const timer = setTimeout(
    () =>
      done({
        status: "inconclusive",
        code: "VERIFIER_TIMEOUT",
        detail:
          phase === "waiting-for-load"
            ? `no document load within ${PROBE_TIMEOUT_MS} ms`
            : `no measurement after document load within ${PROBE_TIMEOUT_MS} ms`,
      }),
    PROBE_TIMEOUT_MS,
  );
  // The load listener and the post-close ready-state check are BOTH paths to
  // measurement; this guard keeps a document that was already complete from
  // being measured twice.
  let measurementScheduled = false;
  const scheduleMeasurement = (): void => {
    if (settled || measurementScheduled) return;
    measurementScheduled = true;
    phase = "waiting-for-settle";
    // The settle is a scheduling aid with a deadline, never a dependency on a
    // clock that ticks: two parent frames when the page paints, PROBE_SETTLE_MS
    // when it does not (issue #504). Measurement itself forces synchronous
    // layout, which a hidden page performs on demand — only paint stops.
    void settleForMeasurement(window, PROBE_SETTLE_MS).then(() => {
      if (settled) return;
      let probe: PlanDiagnostic[];
      try {
        probe = measureProbeFrame(frame, violations, width);
      } catch (err) {
        done({
          status: "inconclusive",
          code: "VERIFIER_UNAVAILABLE",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
        return;
      }
      done({ status: "measured", diagnostics: probe });
    });
  };
  const violations: string[] = [];
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Offscreen without hidden visibility: the document must lay out as the
  // real review frame would, and an inherited `hidden` would make every
  // valid child fail the new visibility check.
  frame.style.cssText =
    `position:absolute;left:-100000px;top:0;width:${width}px;height:600px;pointer-events:none;border:0`;
  document.body.appendChild(frame);
  const childWin = frame.contentWindow;
  const childDoc = frame.contentDocument;
  if (childWin === null || childDoc === null) {
    done({ status: "inconclusive", code: "VERIFIER_UNAVAILABLE", detail: "no same-origin probe document" });
    return promise;
  }
  // document.write keeps ONE child window alive, so a violation listener
  // attached HERE sees blocked loads from the very first parse step —
  // violations dispatch inside the child, and only a same-origin window
  // (the single granted token) can carry them back.
  childWin.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
    violations.push(event.blockedURI);
  });
  childDoc.open();
  // The load listener binds AFTER open() so it observes the intended
  // document's load, not the initial about:blank document's.
  frame.addEventListener("load", () => scheduleMeasurement(), { once: true });
  childDoc.write(doc);
  childDoc.close();
  // close() on an already-parsed document may complete synchronously; cover
  // that race here instead of relying on the load event alone.
  if (childDoc.readyState === "complete") scheduleMeasurement();
  return promise;
};

/** The measurements §4 prescribes, taken in the child's own coordinate space. */
function measureProbeFrame(
  frame: HTMLIFrameElement,
  violations: string[],
  width: number,
): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  const childWin = frame.contentWindow;
  const childDoc = frame.contentDocument;
  if (childWin === null || childDoc === null) {
    throw new Error("probe frame lost its same-origin window");
  }
  const root = childDoc.documentElement;
  const body = childDoc.body;

  if (violations.length > 0) {
    out.push({
      code: "EXTERNAL_RESOURCE",
      stage: "layout",
      repair: "source",
      severity: "error",
      message: "the document attempted to load blocked resources",
      detail: violations.slice(0, 5).join(", ").slice(0, 1000),
    });
  }

  // Broken required embedded images: complete-but-failed loads with no pixels.
  for (const img of Array.from(childDoc.querySelectorAll("img"))) {
    if (img.complete && img.naturalWidth === 0 && img.currentSrc !== "") {
      out.push({
        code: "EXTERNAL_RESOURCE",
        stage: "layout",
        repair: "source",
        severity: "error",
        message: "an embedded image could not be loaded",
        detail: (img.currentSrc || img.getAttribute("src") || "").slice(0, 200),
      });
    }
  }

  // Visible content: real descendants only; body padding alone does not pass.
  let visibleContent = false;
  const isVisible = (el: Element): boolean =>
    typeof el.checkVisibility === "function"
      ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
      : !!(el as HTMLElement).offsetParent || el === childDoc.body;
  const candidates = Array.from(body.querySelectorAll("*")).slice(0, 4000);
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const drawable =
      tag === "svg" ||
      tag === "img" ||
      tag === "canvas" ||
      tag === "video" ||
      el instanceof SVGElement;
    if (drawable) {
      visibleContent = true;
      break;
    }
    const textChild = Array.from(el.childNodes).find(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    if (textChild !== undefined) {
      const range = childDoc.createRange();
      range.selectNodeContents(textChild);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects.item(i);
        if (r !== null && r.width > 0 && r.height > 0) {
          visibleContent = true;
          break;
        }
      }
      if (visibleContent) break;
    }
  }
  if (!visibleContent) {
    out.push({
      code: "LAYOUT_EMPTY",
      stage: "layout",
      repair: "source",
      severity: "error",
      message: "the document laid out no visible content",
      detail: `measured at ${Math.round(width)}px`,
    });
    return out;
  }

  // Document-level horizontal overflow beyond 1 CSS pixel fails. An explicit
  // scroll container (overflow-x other than visible) may overflow inside it.
  const rootWidth = root.getBoundingClientRect().width;
  const withinScrollContainer = (el: Element | null): boolean => {
    let node: Element | null = el;
    while (node !== null && node !== root) {
      const overflowX = childWin.getComputedStyle(node).overflowX;
      if (overflowX !== "visible" && node !== body) return true;
      node = node.parentElement;
    }
    return false;
  };
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right > rootWidth + 1 || rect.left < -1) {
      if (withinScrollContainer(el)) continue;
      out.push({
        code: "LAYOUT_OVERFLOW",
        stage: "layout",
        repair: "source",
        severity: "error",
        message: "content overflows the document horizontally",
        detail: `<${el.tagName.toLowerCase()}> at ${Math.round(rect.width)}px wide`,
      });
      break;
    }
  }
  return out;
}

/**
 * Resolves on the FIRST of two animation frames on `win`'s clock or
 * `timeoutMs` elapsing. The frames keep a painting page's measurement exactly
 * as deterministic as it was; the timer is the arm that survives a page whose
 * clock has stopped. Chromium does not throttle requestAnimationFrame on a
 * hidden page — it stops calling it (the transcript batcher banks on the same
 * fact, store/slices/shared.ts), so a proposal that landed while the window was
 * occluded, minimized, or on another workspace waited on a clock that never
 * ticked and timed out over a perfectly good document (issue #504).
 *
 * Exported for its own contract test: the surviving arm IS the fix, and a
 * layout-less test environment can never reach it through probePlanLayout,
 * which short-circuits before any frame exists.
 */
export function settleForMeasurement(win: Window, timeoutMs: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = win.setTimeout(() => resolve(), timeoutMs);
  win.requestAnimationFrame(() =>
    win.requestAnimationFrame(() => {
      win.clearTimeout(timer);
      resolve();
    }),
  );
  return promise;
}
