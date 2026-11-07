import { CH, type FleetToolAccess, type RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";
import type { LiveEntry } from "./live-entry";

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
 * session behind: version probes, `--no-session` one-shots, and print mode
 * (`-p`/`--print`), which processes a prompt and exits (issue #1075).
 */
const NO_SESSION_ARGUMENTS: Record<string, true> = {
  "--version": true,
  "-v": true,
  "--no-session": true,
  "--print": true,
  "-p": true,
};

/**
 * omp's help interception. Separate from NO_SESSION_ARGUMENTS because it
 * wins from every position the real binary was checked at — even quoted and
 * even after `--` — where the other waivers stop at `--`.
 */
const HELP_ARGUMENTS: Record<string, true> = { "--help": true, "-h": true };

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
  // Waiver semantics verified against the real omp 18.17 binary:
  // - Bash erases quoting before argv, so a separate word equal to
  //   `--help`/`-h` reaches oclif as the help flag from ANY position — even
  //   quoted (`omp --system-prompt '--help' 'go'` prints help, exit 0) and
  //   even after `--`. Only the inline `--system-prompt=--help` form binds
  //   it as a value (verified: model resolution, no help); tokens carrying
  //   `=` are never exact matches here.
  // - After a bare `--`, option parsing is over (`omp -- --version go`
  //   reaches model resolution, never printing a version), so non-help
  //   arguments there are prompt text and do not waive.
  // - The other waivers fire on any separate word, even one a string flag
  //   would consume as its value: `omp --system-prompt '-v' 'go'` really
  //   does resolve the model (verified — `-v` was eaten as a value), yet the
  //   matcher waives. It holds no flag table, and over-silence on that shape
  //   keeps the notice trustworthy, which is #1075's whole point.
  let afterDashDash = false;
  for (const arg of args) {
    if (arg.text === "--" && !arg.quoted) {
      afterDashDash = true;
      continue;
    }
    // Exact whole-word match, so the inline `--system-prompt=--help` value
    // form (which oclif really binds as a value) is never mistaken for it.
    if (HELP_ARGUMENTS[arg.text] === true) return false;
    if (!afterDashDash && NO_SESSION_ARGUMENTS[arg.text] === true) return false;
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
 * their newline, heredoc bodies (`<<`, `<<-`, `<<<`, any spacing, delimiters
 * consumed strictly in opening order) are skipped line-wise, arithmetic
 * (`((…))`, `$((…))`) is evaluated and never scanned as commands, and a
 * redirect's operand word never opens a command position (`> omp` truncates
 * a file).
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
      // Strict opening order: the body currently open always belongs to the
      // earliest unterminated `<<`; a line matching a LATER delimiter is
      // just body text (bash's own "wanted `B'" warning proves the pairing).
      const pending = frame.heredocs[0]!;
      let end = command.indexOf("\n", i);
      const atEof = end === -1;
      if (atEof) end = n;
      const line = command.slice(i, end);
      i = atEof ? n : end + 1;
      const candidate = pending.dash ? line.replace(/^\t+/, "") : line;
      if (candidate === pending.delim) frame.heredocs.shift();
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

  /**
   * Consume one balanced parenthesis group whose two opening `(` are already
   * read. Used for `((…))` and `$((…))`: arithmetic is evaluated, never
   * executed as commands, so its contents are inert — not even scanned (a
   * nested `$()` inside arithmetic would be missed; that exotic shape keeps
   * the silent bias rather than re-opening the parser here).
   */
  const skipBalancedArithmetic = (): void => {
    let depth = 2;
    while (i < n && depth > 0) {
      const c = command[i]!;
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
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
      if (command[i] === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
        // Quoted `$((…))` still evaluates arithmetic: inert, never a command.
        i += 3;
        skipBalancedArithmetic();
        continue;
      }
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
      // `$((…))` arithmetic evaluates; its words are variables, not commands.
      if (command[i + 2] === "(") {
        i += 3;
        skipBalancedArithmetic();
        continue;
      }
      openFrame(")");
      i += 2;
      continue;
    }
    if (ch === "(") {
      // `((…))` arithmetic evaluates; its words are variables, not commands.
      // A plain `(` opens a subshell group whose contents stay scanned.
      if (command[i + 1] === "(") {
        i += 2;
        skipBalancedArithmetic();
        continue;
      }
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
          // Bash allows blanks between `<<<` and the word (`<<< foo`).
          i += 3;
          while (i < n && /[ \t]/.test(command[i]!)) i += 1;
          readToken();
          continue;
        }
        // Heredoc: record the delimiter; the body is skipped after the line.
        // Bash reads the word right after `<<` or `<<-`, blanks and tabs
        // between allowed (`cat << EOF` is a real heredoc with delimiter
        // EOF); the word itself still stops at the first blank.
        i += 2;
        const dash = command[i] === "-";
        if (dash) i += 1;
        while (i < n && /[ \t]/.test(command[i]!)) i += 1;
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
  // Unclosed syntax at EOF — an open `(`/`$(`/backtick frame or an open
  // quote — is a parse error: bash rejects the WHOLE command before anything
  // executes (`echo $(omp` launches nothing). Silence bias per #1075: when
  // the parse never completed, no launch is claimed. An unterminated
  // heredoc body does not count; bash still feeds it to the command at EOF.
  const syntaxIncomplete = frames.length > 1 || frames.some((f) => f.quote !== null);
  if (syntaxIncomplete) return false;

  return commands.some(commandLaunchesForeignSession);
}

export interface ForeignOmpTrackerDeps {
  send: (channel: string, ...args: unknown[]) => void;
}

/** The orphan symptom, common to every guidance branch below (issue #1022). */
const ORPHAN_SYMPTOM =
  "This session launched a bare `omp` child. That child is invisible to omp-ui " +
  "(ADR-0003): it spends money untracked, appears in no sidebar row, and no one " +
  "answers its prompts. ";

/**
 * What to do about it, per the session's actual fleet-tool access (issue #1076).
 * The advice names the route that really exists for THIS session — decided by
 * the one `fleetToolAccess` rule the spawn gate itself uses — never a setting
 * trip that cannot help: a chat already carries the tools whatever the setting
 * says (#945), and a dispatched or outside-sender session is refused them on
 * purpose, so no toggle changes it.
 */
function guidance(access: FleetToolAccess): string {
  switch (access) {
    case "granted":
      // A chat, or an ordinary session with the setting already on: the tools
      // are HERE; pointing at Settings would send the user to a switch that is
      // already doing its job (or one chats ignore).
      return (
        "This session already has the fleet tools (`omp-ui_fleet_machines`, " +
        "`omp-ui_fleet_dispatch`): use them to start sessions omp-ui can see, " +
        "wake and manage instead of spawning `omp` by hand."
      );
    case "setting-off":
      // The only case where the setting is the honest fix.
      return (
        "To give an agent sessions omp-ui can see, wake and manage, enable " +
        "Settings → Remote instances → “Let agents dispatch fleet work” and use " +
        "the fleet tools instead of spawning `omp` by hand."
      );
    case "agent-recursion":
      // ADR-0061's no-recursion gate: no toggle opens this. The supported move
      // is to hand the need back up the dispatch chain.
      return (
        "This session was dispatched by another agent, so omp-ui deliberately " +
        "withholds the fleet tools from it — no setting changes that (ADR-0061). " +
        "Work that needs its own agent session belongs in your reply: say what " +
        "needs dispatching and let the dispatching session (or the user) start it."
      );
    case "external-sender":
      // ADR-0075 / ADR-0080: an outside sender's session, tools refused on
      // purpose; the honest route is a human-started session.
      return (
        "This session was started by a webhook or an MCP client, so omp-ui " +
        "deliberately withholds the fleet tools from it — no setting changes " +
        "that (ADR-0075, ADR-0080). Work that needs its own agent session has " +
        "to be asked of the user in a session they start here."
      );
  }
}

/**
 * Notices an agent launching a bare `omp` from inside its own session
 * (issue #1022). ADR-0003 keeps foreign sessions invisible to omp-ui — this
 * does not surface them as rows and never scrapes pty tabs, which carry only
 * raw bytes and are unobservable here. It fires the issue's "loud instead of
 * silent" option: one warn notice on the OWNING session's transcript, naming
 * the orphaned-session symptom and the supported route (fleet dispatch).
 * Issue #1075 narrowed the trigger to real session-starting launches so the
 * notice keeps its meaning; issue #1076 tailored the guidance to this
 * session's actual fleet-tool access instead of always sending the user to a
 * setting that chats ignore and dispatched sessions are refused outright.
 */
export class ForeignOmpTracker implements FrameObserver {
  /** Tabs already warned for the CURRENT live process; cleared on every exit. */
  private readonly warnedTabs = new Set<string>();

  constructor(private readonly deps: ForeignOmpTrackerDeps) {}

  onFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void {
    if (entry.kind !== "rpc-ui") return;
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
      message: ORPHAN_SYMPTOM + guidance(entry.fleetToolAccess),
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
