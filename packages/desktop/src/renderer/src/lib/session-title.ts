/**
 * Session auto-titling gates for rpc-ui tabs.
 *
 * omp titles itself only in the TUI (`input-controller.ts`
 * #maybeStartTitleGeneration); `--mode=rpc-ui` never does. So omp-ui asks
 * omp to do it: when the first substantive prompt's turn admits its user
 * `message_start` — the frame that carries the prompt into omp's history
 * (the ack pre-dates it, so the ack alone dispatches an empty digest) —
 * it sends the bare `/rename`, whose generator digests the conversation,
 * walks the configured model chain, retries, and applies omp's own title
 * precedence (issues #788, #795). The first untitled `agent_end` stays the
 * safety net — the shot goes out there when the turn admitted no user
 * message. A declined generation is no longer lost: the dispatch
 * outcome is judged at later turn ends against the record's title (the
 * ground truth, never engine output strings) and an untitled record
 * re-dispatches — three attempts with a 15 s floor — so one per-model
 * decline doesn't leave the session `New session` forever (issue #791).
 * What stays here is the omp-ui gates that decide whether a dispatch is
 * worth spending.
 *
 * Live voice is the third route (issue #803): omp's live controller hands the
 * spoken request over as an agent-attributed `live-delegation` custom
 * message, which no send path arms and omp's digest skips. The reducer arms
 * it in the renderer that started live voice and holds the shot for the
 * first assistant `message_end` that carries text or thinking.
 *
 * A title omp-ui writes itself with `set_session_name` lands with source
 * `"user"`, and omp (verified in 18.0.4) refuses every later `"auto"` title
 * once one exists. Hence the untitled-record check in `setInitialPrompt`:
 * a resumed or user-named session must never be handed to the generator.
 * Latching a shot onto a greeting is the other thing worth avoiding, which
 * is what the low-signal filter below gates — mirroring omp's own
 * `isLowSignalTitleInput` deferral.
 */

/**
 * Greeting / acknowledgement / filler tokens — port of omp's
 * FILLER_TITLE_TOKENS (`src/tiny/text.ts`, v17.1.8). A first message made only
 * of these carries no task, so titling defers to the next message.
 */
const FILLER_TITLE_TOKENS = new Set([
  // greetings
  "hi", "hii", "hiii", "hiya", "hey", "heya", "hello", "helo", "hullo",
  "yo", "ya", "sup", "wassup", "whatsup", "howdy", "greetings", "hola",
  "ciao", "aloha", "gm", "gn", "good", "morning", "afternoon", "evening",
  "night", "day",
  // politeness / acknowledgement
  "thanks", "thank", "thx", "ty", "tysm", "cheers", "please", "pls", "plz",
  "ok", "okay", "okey", "k", "kk", "yep", "yes", "yeah", "yup", "nope",
  "no", "nah", "sure", "cool", "nice", "great", "awesome", "perfect",
  "lol", "lmao", "haha", "hehe",
  // poking the agent / fillers
  "test", "tests", "testing", "ping", "pong", "there", "you", "u",
  "hmm", "hmmm", "um", "uh", "so", "well", "anyway",
]);

const TITLE_WORD = /[\p{L}\p{N}]+/gu;
/** Fenced code block (3+ backticks), including an unterminated trailing fence. */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
/** A paired XML/HTML-ish block, e.g. `<user>…</user>`. */
const XML_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

/**
 * True when a first user message is too low-signal to title from (greeting,
 * ack, bare number, or empty once code and punctuation are stripped).
 *
 * Follows omp's `isLowSignalTitleInput`, with one deliberate divergence: omp's
 * `stripCodeBlocks` restores the original message when stripping leaves under
 * 12 chars, so omp titles a first message that is *only* a pasted snippet.
 * omp-ui defers instead — a snippet with no prose is not a task, and omp's own
 * auto titling is latched out once a "user" title exists, and only a later
 * user-sourced rename can supersede one.
 */
export function isLowSignalTitleInput(message: string): boolean {
  const cleaned = message.replace(XML_BLOCK, " ").replace(FENCED_CODE_BLOCK, " ");
  const tokens = cleaned.toLowerCase().match(TITLE_WORD);
  if (!tokens) return true;
  return tokens.every((token) => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

/**
 * True when `title` marks a session as still unnamed, so auto-titling may
 * claim it. Blank/absent means no record yet or an empty title slot; "New
 * session" is the sidebar's placeholder for exactly that (backend.ts:407).
 */
export function isUntitled(title: string | null | undefined): boolean {
  const trimmed = title?.trim();
  return !trimmed || trimmed.toLowerCase() === "new session";
}
