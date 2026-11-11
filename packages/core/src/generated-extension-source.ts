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

/**
 * Redirect recognition for the background-jobs bridge (issue #1154). The
 * generated source declares `redirectTarget(rawCommand)`: the one literal
 * file-redirect destination of a single simple bash command, or null when
 * anything about the command makes attribution untrustworthy — pipelines,
 * compound commands, heredocs/input redirects, substitutions, subshells,
 * backgrounding, multiple destinations, dynamic targets. Recognition is
 * declined wholesale in those cases so a tail is never misattributed to a
 * file another part of the command touched. Comparisons use char codes so
 * this fragment carries no escape sequences through the template literal.
 */
export function generatedRedirectScannerSource(): string {
  return `/** One literal file-redirect destination of a simple command, or null. */
function redirectTarget(raw: string): string | null {
  const n = raw.length;
  const at = (k: number): number => (k >= 0 && k < n ? raw.charCodeAt(k) : -1);
  const isSpace = (c: number): boolean => c === 32 || c === 9; // space, tab
  const isDigit = (c: number): boolean => c >= 48 && c <= 57;
  // Metacharacters that end a word; any unquoted occurrence either gets
  // consumed by the operator rules below or declines the whole command.
  const stopsWord = (c: number): boolean =>
    c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 124 || c === 38 ||
    c === 59 || c === 40 || c === 41 || c === 36 || c === 96;
  const badTarget = (value: string): boolean => {
    if (value === "" || value.charCodeAt(0) === 126) return true; // empty, or tilde expansion
    for (let k = 0; k < value.length; k++) {
      const c = value.charCodeAt(k);
      if (c <= 31 || c === 127) return true;
      // Dynamic targets never resolve: expansion, command substitution, globs.
      if (c === 36 || c === 96 || c === 42 || c === 63 || c === 91) return true;
    }
    return false;
  };
  // A single-quoted region (content fully literal) past its closing quote; -1 when unterminated.
  const skipSingle = (from: number): number => {
    for (let k = from + 1; k < n; k++) if (raw.charCodeAt(k) === 39) return k + 1;
    return -1;
  };
  // A double-quoted region past its closing quote, honoring only backslash
  // and quote escapes; -1 when unterminated.
  const skipDouble = (from: number): number => {
    for (let k = from + 1; k < n; k++) {
      const c = raw.charCodeAt(k);
      if (c === 92) k++;
      else if (c === 34) return k + 1;
    }
    return -1;
  };
  // One ordinary word argument, consumed and discarded; -1 declines.
  const skipWord = (from: number): number => {
    let k = from;
    for (;;) {
      const c = at(k);
      if (c === -1 || stopsWord(c)) return k;
      if (c === 92) {
        if (at(k + 1) === -1) return -1;
        k += 2;
        continue;
      }
      if (c === 39) {
        const e = skipSingle(k);
        if (e < 0) return -1;
        k = e;
        continue;
      }
      if (c === 34) {
        const e = skipDouble(k);
        if (e < 0) return -1;
        k = e;
        continue;
      }
      k++;
    }
  };
  // The target word at the read position: adjacent quoted/bare segments
  // assemble into one path until unquoted whitespace or a metacharacter.
  // null declines the whole command (empty or dynamic target, unterminated quote).
  const readTarget = (from: number): { text: string; end: number } | null => {
    let k = from;
    while (isSpace(at(k))) k++;
    let text = "";
    for (;;) {
      const c = at(k);
      if (c === -1 || stopsWord(c)) break;
      if (c === 35 && text === "") return null; // a comment where the target belongs: empty target
      if (c === 39) {
        const e = skipSingle(k);
        if (e < 0) return null;
        text += raw.slice(k + 1, e - 1);
        k = e;
        continue;
      }
      if (c === 34) {
        k++;
        for (;;) {
          const d = at(k);
          if (d === -1) return null;
          if (d === 92) {
            const e = at(k + 1);
            if (e === -1) return null;
            text += e === 92 || e === 34 ? String.fromCharCode(e) : String.fromCharCode(92, e);
            k += 2;
            continue;
          }
          if (d === 34) {
            k++;
            break;
          }
          text += raw.charAt(k);
          k++;
        }
        continue;
      }
      if (c === 92) {
        const e = at(k + 1);
        if (e === -1) return null;
        text += String.fromCharCode(e);
        k += 2;
        continue;
      }
      text += raw.charAt(k);
      k++;
    }
    return badTarget(text) ? null : { text, end: k };
  };
  let i = 0;
  let target: string | null = null;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === 92) {
      if (at(i + 1) === -1) return null;
      i += 2;
      continue;
    }
    if (c === 39) {
      const e = skipSingle(i);
      if (e < 0) return null;
      i = e;
      continue;
    }
    if (c === 34) {
      const e = skipDouble(i);
      if (e < 0) return null;
      i = e;
      continue;
    }
    if (c === 35 && (i === 0 || isSpace(at(i - 1)))) {
      while (i < n && raw.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 38 && at(i + 1) === 62) {
      // &> / &>> file redirect; >&N and >&- are descriptor duplication the
      // plan declines in leading position, never a destination.
      const next = at(i + 2);
      if (isDigit(next) || next === 45) return null;
      let k = i + 2;
      if (at(k) === 62) k++;
      if (target !== null) return null;
      const read = readTarget(k);
      if (read === null) return null;
      target = read.text;
      i = read.end;
      continue;
    }
    if (c === 62) {
      let k = i + 1;
      if (at(k) === 38) {
        // Descriptor duplication (>&N / >&-): consumed, never attributed.
        k++;
        if (at(k) === 45) k++;
        while (isDigit(at(k))) k++;
        i = k;
        continue;
      }
      if (at(k) === 62 || at(k) === 124) k++; // append, or clobber
      if (target !== null) return null; // a second file redirect
      const read = readTarget(k);
      if (read === null) return null;
      target = read.text;
      i = read.end;
      continue;
    }
    if (c === 124 || c === 38 || c === 59 || c === 10 || c === 60 || c === 40 || c === 41 || c === 36 || c === 96) {
      return null; // pipe, backgrounding, separator, input redirect, substitution, subshell
    }
    const e = skipWord(i);
    if (e < 0) return null;
    i = e;
  }
  return target;
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
