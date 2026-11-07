import { CH, type RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/**
 * A bare `omp` launch inside an owned session's bash command (issue #1022):
 * `omp` as the command word of a simple command — at a command position, not
 * quoted prose, a heredoc body, or an argument — and invoked so it starts or
 * resumes a session. omp-ui's own managed children are spawned by path and
 * never through an agent's bash tool, so a bare name in command position here
 * is always a foreign launch rather than self-invocation.
 *
 * Issue #1075 replaced the old "the word `omp` after any whitespace" regex:
 * over 14 days of session logs it fired on 69 commands and almost none were
 * launches — commit-message prose, `which omp`, `omp --version`, heredocs,
 * directory names. The matcher now scans the command like a shell (quotes,
 * substitutions, comments, heredocs, redirects) splitting it into simple
 * commands, then classifies each command word: only `omp` in command
 * position counts, and only when its own arguments ask for a session —
 * probes (`--version`, `--help`, `config`/`models`/`token`) and runs that
 * leave no session behind (`--no-session`, print mode) do not.
 */

/** Subcommands of omp that never start or resume a session (issue #1075). */
const NON_SESSION_SUBCOMMANDS: Record<string, true> = { config: true, models: true, token: true };

/**
 * Arguments that make an `omp` invocation a probe or a run that leaves no
 * session behind: version/help probes, `--no-session` one-shots, and print
 * mode (`-p`/`--print`), which processes a prompt and exits (issue #1075).
 */
const NO_SESSION_ARGUMENTS: Record<string, true> = {
  "--version": true,
  "-v": true,
  "--help": true,
  "-h": true,
  "--no-session": true,
  "--print": true,
  "-p": true,
};

/** Shell words that run the command after them; `omp` hides behind them. */
const COMMAND_WRAPPERS: Record<string, true> = {
  time: true,
  exec: true,
  nohup: true,
  sudo: true,
  env: true,
  if: true,
  while: true,
  until: true,
  do: true,
  then: true,
  else: true,
};

/**
 * Name-lookup shell builtins (`command -v omp`, `type omp`): they describe a
 * program without running it, so a command led by one never counts as a
 * launch. Their forwarding forms (`command omp …`) are rare enough that the
 * matcher's silence bias (issue #1075) is the better default than modeling
 * which flags execute.
 */
const LOOKUP_BUILTINS: Record<string, true> = {
  command: true,
  type: true,
  whence: true,
  hash: true,
  alias: true,
};

/** A leading `NAME=` environment assignment runs the command after it. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface ShellWord {
  /** The word with quote characters removed (contents kept). */
  text: string;
  /** True when the word BEGINS with a quote: its text is prose/data. */
  quoted: boolean;
}

/**
 * One simple command's words: does this command run a bare `omp` in a way
 * that starts or resumes a session? Leading env assignments and wrapper
 * words (with their flags) are stepped over; the first real command word
 * must be exactly `omp` — a path like `/usr/local/bin/omp`, a quoted `"omp"`,
 * or a larger token is data, not the bare launch #1022 warns about. None of
 * the following words may carry a no-session argument, and the first one may
 * not name a session-free subcommand.
 */
function commandLaunchesForeignSession(words: ShellWord[]): boolean {
  let launchAt = -1;
  let afterWrapper = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.quoted) return false;
    if (LOOKUP_BUILTINS[word.text] === true) return false;
    if (word.text === "omp") {
      launchAt = i;
      break;
    }
    if (ENV_ASSIGNMENT.test(word.text)) continue;
    if (COMMAND_WRAPPERS[word.text] === true) {
      afterWrapper = true;
      continue;
    }
    // A flag here belongs to the wrapper: the scanner does not model flags
    // that consume a value, so only bare flags are stepped over.
    if (afterWrapper && word.text.startsWith("-")) continue;
    return false;
  }
  if (launchAt === -1) return false;
  const args = words.slice(launchAt + 1);
  for (const arg of args) {
    if (NO_SESSION_ARGUMENTS[arg.text] === true) return false;
  }
  // A subcommand position only exists before any flag: `omp --model x config`
  // reads "config" as a flag value, not a subcommand.
  const first = args[0];
  if (first !== undefined && !first.text.startsWith("-") && NON_SESSION_SUBCOMMANDS[first.text] === true) {
    return false;
  }
  return true;
}

/** One quote/substitution nesting level, plus its own pending heredocs. */
interface ShellFrame {
  /** What closes this frame: `)` for `$(` and `(`, a backtick for `` `…` ``. */
  closer: ")" | "`" | null;
  /** This frame's live quote state; inside a quote, metacharacters are inert. */
  quote: "sq" | "dq" | null;
  /** Words scanned since this frame's last separator. */
  bucket: ShellWord[];
  /** Heredocs opened on the current line; bodies run after its newline. */
  heredocs: { delim: string; dash: boolean }[];
}

/**
 * True when `command` runs a bare `omp` from a command position in a way that
 * starts or resumes a session, with issue #1075's exclusions applied per
 * launch. Quotes, backticks and `$(…)` interiors are tracked — a launch
 * inside `$(…)` still executes, quoted prose does not. `#` comments end at
 * their newline, heredoc bodies are skipped line-wise, and a redirect's
 * operand word never opens a command position (`> omp` truncates a file).
 */
export function launchesBareOmpSession(command: string): boolean {
  const n = command.length;
  const frames: ShellFrame[] = [{ closer: null, quote: null, bucket: [], heredocs: [] }];
  const commands: ShellWord[][] = [];
  let word = "";
  let wordQuoted = false;
  let inWord = false;
  // Set after a redirect operator: the next word is a file, not a command.
  let skipOperand = false;
  // True while the redirect's operand token is still open or unconsumed.
  let operandOpen = false;

  const top = () => frames[frames.length - 1]!;
  const flushWord = () => {
    if (!inWord) return;
    inWord = false;
    if (skipOperand) {
      skipOperand = false;
      operandOpen = false;
    } else {
      top().bucket.push({ text: word, quoted: wordQuoted });
    }
    word = "";
    wordQuoted = false;
  };
  const appendChar = (ch: string) => {
    if (!inWord) {
      word = "";
      wordQuoted = false;
      inWord = true;
      operandOpen = true;
    }
    word += ch;
  };
  const endCommand = () => {
    flushWord();
    commands.push(top().bucket);
    top().bucket = [];
    skipOperand = false;
    operandOpen = false;
  };
  const openFrame = (closer: ")" | "`") => {
    flushWord();
    frames.push({ closer, quote: null, bucket: [], heredocs: [] });
  };
  const closeFrame = () => {
    flushWord();
    const frame = frames.pop()!;
    commands.push(frame.bucket);
  };

  /** Read this frame's heredoc bodies line by line until each delimiter lands. */
  const consumeHeredocs = (frame: ShellFrame) => {
    while (i < n && frame.heredocs.length > 0) {
      let end = command.indexOf("\n", i);
      const atEof = end === -1;
      if (atEof) end = n;
      const line = command.slice(i, end);
      i = atEof ? n : end + 1;
      for (let k = 0; k < frame.heredocs.length; k++) {
        const pending = frame.heredocs[k]!;
        const candidate = pending.dash ? line.replace(/^\t+/, "") : line;
        if (candidate === pending.delim) {
          frame.heredocs.splice(k, 1);
          break;
        }
      }
    }
  };

  /** Consume a quoted or bare token at `i` (delimiter/here-string word). */
  const readToken = (): string => {
    let out = "";
    const quoteCh = command[i] === "'" || command[i] === '"' ? command[i] : null;
    if (quoteCh !== null) i += 1;
    while (i < n) {
      const c = command[i]!;
      if (quoteCh !== null ? c === quoteCh : /[\s;|&<>()]/.test(c)) {
        if (quoteCh !== null) i += 1;
        break;
      }
      out += c;
      i += 1;
    }
    return out;
  };

  let i = 0;
  while (i < n) {
    const frame = top();
    const ch = command[i]!;

    if (frame.quote === "sq") {
      // Nothing is special inside single quotes — the body is pure data.
      const close = command.indexOf("'", i);
      if (close === -1) {
        appendChar(command.slice(i));
        i = n;
      } else {
        if (close > i) appendChar(command.slice(i, close));
        i = close + 1;
        frame.quote = null;
      }
      continue;
    }

    if (frame.quote === "dq") {
      // Double quotes keep their text as data, except `$(` and backticks,
      // which still execute.
      let j = i;
      let closed = false;
      while (j < n) {
        const c = command[j]!;
        if (c === "\\") {
          appendChar(command.slice(j, Math.min(j + 2, n)));
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "`" || (c === "$" && command[j + 1] === "(")) break;
        appendChar(c);
        j += 1;
      }
      i = j;
      if (closed) {
        frame.quote = null;
        i += 1;
        continue;
      }
      if (i >= n) break;
      // A substitution opens inside the quoted word: its body is code, and
      // the outer command's first word was data — only a launch INSIDE the
      // substitution can warn from here.
      openFrame(command[i] === "`" ? "`" : ")");
      i += command[i] === "`" ? 1 : 2;
      continue;
    }

    // Unquoted command context.
    if (ch === " " || ch === "\t") {
      // No operand reset here: the operand word of `> omp` may start after
      // this gap.
      flushWord();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endCommand();
      i += 1;
      consumeHeredocs(frame);
      continue;
    }
    if (ch === "#" && !inWord && !operandOpen) {
      // A comment runs to the end of its line: no command position inside.
      const end = command.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === "\\") {
      // A backslash-newline joins lines without ending the word; anything
      // else escapes the next character into the word.
      if (command[i + 1] !== "\n") appendChar(command.slice(i + 1, i + 2));
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (!inWord) wordQuoted = true;
      inWord = true;
      operandOpen = true;
      frame.quote = "sq";
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (!inWord) wordQuoted = true;
      inWord = true;
      operandOpen = true;
      frame.quote = "dq";
      i += 1;
      continue;
    }
    if (ch === "`") {
      // A backtick opens an expansion; the same character closes the frame
      // it opened, exactly like bash's word-level pairing.
      if (frame.closer === "`") closeFrame();
      else openFrame("`");
      i += 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      openFrame(")");
      i += 2;
      continue;
    }
    if (ch === "(") {
      // Subshell groups and `((…))` arithmetic both close with `)`; either
      // way their contents are scanned as commands in their own frame.
      openFrame(")");
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (frames.length > 1) closeFrame();
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&") {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      flushWord();
      // `<<`/`<<<` are here-documents/here-strings, not file redirects.
      const isHeredoc = ch === "<" && command[i + 1] === "<";
      if (isHeredoc) {
        if (command[i + 2] === "<") {
          // Here-string: its whole token is data, never a command position.
          i += 3;
          readToken();
          continue;
        }
        // Heredoc: record the delimiter; the body is skipped after the line.
        i += 2;
        const dash = command[i] === "-";
        if (dash) {
          i += 1;
          // `<<-` separates itself from the delimiter with tabs/spaces.
          while (i < n && /[ \t]/.test(command[i]!)) i += 1;
        }
        const delim = readToken();
        if (delim !== "") frame.heredocs.push({ delim, dash });
        continue;
      }
      skipOperand = true;
      operandOpen = false;
      i += command[i + 1] === ch ? 2 : 1;
      continue;
    }
    appendChar(ch);
    i += 1;
  }
  endCommand();
  while (frames.length > 1) closeFrame();

  return commands.some(commandLaunchesForeignSession);
}

export interface ForeignOmpTrackerDeps {
  send: (channel: string, ...args: unknown[]) => void;
}

/**
 * Notices an agent launching a bare `omp` from inside its own session
 * (issue #1022). ADR-0003 keeps foreign sessions invisible to omp-ui — this
 * does not surface them as rows and never scrapes pty tabs, which carry only
 * raw bytes and are unobservable here. It fires the issue's "loud instead of
 * silent" option: one warn notice on the OWNING session's transcript, naming
 * the orphaned-session symptom and the supported route (fleet dispatch).
 * Issue #1075 narrowed the trigger to real session-starting launches so the
 * notice keeps its meaning.
 */
export class ForeignOmpTracker implements FrameObserver {
  /** Tabs already warned for the CURRENT live process; cleared on every exit. */
  private readonly warnedTabs = new Set<string>();

  constructor(private readonly deps: ForeignOmpTrackerDeps) {}

  onFrame(tabId: string, frame: RpcFrame): void {
    if (frame.type !== "tool_execution_start" || frame.toolName !== "bash") return;
    const args = frame.args;
    if (typeof args !== "object" || args === null) return;
    const command = (args as Record<string, unknown>).command;
    if (typeof command !== "string" || !launchesBareOmpSession(command)) return;
    if (this.warnedTabs.has(tabId)) return;
    this.warnedTabs.add(tabId);
    this.deps.send(CH.onRpcFrame, tabId, {
      type: "omp_ui_notice",
      level: "warn",
      source: "omp-ui",
      reason: "foreign-omp-launch",
      message:
        `This session launched a bare \`omp\` child. That child is invisible to omp-ui ` +
        `(ADR-0003): it spends money untracked, appears in no sidebar row, and no one ` +
        `answers its prompts. To give an agent sessions omp-ui can see, wake and manage, ` +
        `enable Settings → Remote instances → “Let agents dispatch fleet work” and use ` +
        `the fleet tools instead of spawning omp by hand.`,
    });
  }

  /** A successor process under the same tab gets its own one-shot warning. */
  onExit(tabId: string): void {
    this.warnedTabs.delete(tabId);
  }

  dispose(tabId: string): void {
    this.warnedTabs.delete(tabId);
  }
}
