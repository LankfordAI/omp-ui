/** Shared source fragments interpolated into generated OMP extensions. */

export function generatedUtf8LengthSource(): string {
  return `function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xdc00 && code < 0xe000) bytes += 0;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}`;
}
export function generatedAsRecordSource(): string {
  return `function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}`;
}

export function generatedPollTimerSource(): string {
  return `interface PollTimer {
  unref?: () => void;
}`;
}

export function generatedRootBindingSource(
  sessionType: string,
  onBindSource = "",
): string {
  const onBind = onBindSource === "" ? "" : `\n    ${onBindSource}`;
  return `function captureRoot(candidate: ${sessionType}): boolean {
  if (rootSession === null) {
    rootSession = candidate;${onBind}
    return true;
  }
  return candidate === rootSession;
}`;
}


export function generatedSessionIdSource(sessionType: string): string {
  return `function sessionIdOf(session: ${sessionType} | null): string | null {
  const manager = session?.sessionManager;
  if (manager === null || typeof manager !== "object") return null;
  const read = (manager as Record<string, unknown>).getSessionId;
  if (typeof read !== "function") return null;
  try {
    const value = read.call(manager);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}`;
}

export function generatedModeTransitionSource(chainName: string): string {
  return `function ${chainName}(): { queue: Promise<void> } {
  const global = globalThis as unknown as Record<PropertyKey, unknown>;
  const key = Symbol.for(TRANSITION_KEY);
  const raw = global[key];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const existing = raw as Record<string, unknown>;
    if (existing.queue instanceof Promise) return existing as unknown as { queue: Promise<void> };
    existing.queue = Promise.resolve();
    return existing as unknown as { queue: Promise<void> };
  }
  const created = { queue: Promise.resolve() };
  try {
    global[key] = created;
  } catch {
    /* a runtime that refuses new symbols keeps this extension's local chain */
  }
  return created;
}

function inTransition<T>(work: () => Promise<T>): Promise<T> {
  const box = ${chainName}();
  const next = box.queue.then(work, work);
  box.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}`;
}

export function generatedShutdownCleanupSource(sessionType: string): string {
  return `function bindShutdown(session: ${sessionType}): void {
  const target = session as unknown as Record<string, unknown>;
  for (const method of ["dispose", "disconnect", "cleanup", "shutdown"]) {
    try {
      const original = target[method];
      if (typeof original !== "function") continue;
      const call = original as (...args: unknown[]) => unknown;
      target[method] = function (this: unknown, ...args: unknown[]): unknown {
        const result = call.apply(this, args);
        try {
          if (this === session) teardown();
        } catch {
          /* shutdown bookkeeping never breaks the session */
        }
        return result;
      };
    } catch {
      /* a sealed or throwing shutdown hook is not our session's problem */
    }
  }
}`;
}

/**
 * Reads omp's own layered settings from inside a generated extension
 * (ADR-0036). The literal dynamic import resolves through omp's bundled-module
 * shim; a computed specifier does not. `readOmpSetting` returns undefined when
 * the registry, the setting, or the value is unreadable — never a guess.
 */
export function generatedOmpSettingReaderSource(): string {
  return `let settingLookup: ((id: string) => unknown) | null = null;
// @ts-expect-error -- omp's extension loader maps this LITERAL specifier to its bundled config
// registry (ADR-0036); a computed specifier does not resolve.
void import("@oh-my-pi/pi-coding-agent/config/registry").then(
  (mod: unknown) => {
    const lookup = (mod as Record<string, unknown> | null)?.lookup;
    if (typeof lookup === "function") settingLookup = lookup as (id: string) => unknown;
  },
  () => undefined,
);

/** omp's effective value of registered setting \`id\` for \`settings\`; undefined when unreadable. */
function readOmpSetting(settings: unknown, id: string): unknown {
  if (settingLookup === null || settings === null || typeof settings !== "object") return undefined;
  try {
    const setting = settingLookup(id) as { get?: unknown } | undefined;
    return typeof setting?.get === "function"
      ? (setting.get as (s: unknown) => unknown).call(setting, settings)
      : undefined;
  } catch {
    return undefined;
  }
}`;
}
