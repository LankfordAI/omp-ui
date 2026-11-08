import { arrField, field, strField } from "./fields";

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
 * re-dispatches — four attempts with a 15 s floor — so one per-model
 * decline doesn't leave the session `New session` forever (issue #791). A
 * ladder that exhausts with the record still untitled appends a give-up
 * notice pointing at the modelRoles title chain (issue #859).
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
 * `isLowSignalTitleInput` deferral. A prompt that filter declines does not lose
 * the title opportunity either (issue #1090): the renderer that sent it holds an
 * assistant-context deferral, and spends the same `/rename` shot once the
 * assistant has produced enough thinking or reply for omp's digest to read —
 * omp's own `DEFERRED_TITLE_MIN_WORDS` rule, so a greeting answered with a
 * greeting still stays unnamed.
 *
 * The fourth route is the replan refresh (issue #804): a `todo` `op:"init"`
 * frame means the work took a new shape, so `refreshAutoTitle` re-dispatches
 * the bare `/rename` — but only while the registry's `autoTitled` marker
 * says the current title is one omp-ui generated. omp records generator
 * titles with source "user", so the on-disk header cannot tell an auto-title
 * from a typed name; the marker can, and every typed rename clears it.
 *
 * The card question (issue #838): the 18.8.9 binary still gates omp's own
 * auto-title off for rpc-ui (`noTitle || mode === "rpc" || "rpc-ui" ||
 * "acp"`), so the `message_start` dispatch above remains our whole timing
 * story; omp's title-starts-at-reply-begin change (its #803) is TUI-only.
 * Legacy card titles carry `${icon} ${code}: ${title}` inside the string;
 * title-card.ts still splits those at render time. New spawns pin
 * `title.icons: boring` for plain titles (issue #1114).
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

/**
 * Thinking + reply words the assistant-context deferral (issue #1090) waits
 * for before spending its one deferred `/rename` — port of omp's
 * `DEFERRED_TITLE_MIN_WORDS` (`agent-session.ts`, v18.18.0), so "meaningful"
 * means here what it means in the TUI: a greeting answered with a greeting
 * never crosses it, a reply that actually reads the task does.
 */
export const DEFERRED_TITLE_MIN_WORDS = 40;

/** Whitespace-separated word count of one digest-visible string run. */
const WORD_RUN = /\S+/g;

/**
 * Words of assistant thinking/reply omp's title digest can read on this
 * settled assistant `message_end` — the port of omp's `titleContextWordCount`
 * (`session/messages.ts`, v18.18.0). Tool calls alone contribute nothing (the
 * same invisibility `carriesTitleDigest` gates the live-voice shot on), and an
 * aborted or errored tail is worth zero: the deferral never counts a turn that
 * produced no real answer.
 */
export function titleContextWords(message: unknown): number {
  const stop = strField(message, "stopReason");
  if (stop === "aborted" || stop === "error") return 0;
  const content = field(message, "content");
  if (typeof content === "string") return content.match(WORD_RUN)?.length ?? 0;
  let words = 0;
  for (const block of arrField(message, "content")) {
    const kind = strField(block, "type");
    const text =
      kind === "text"
        ? strField(block, "text")
        : kind === "thinking"
          ? strField(block, "thinking")
          : undefined;
    if (text !== undefined) words += text.match(WORD_RUN)?.length ?? 0;
  }
  return words;
}
