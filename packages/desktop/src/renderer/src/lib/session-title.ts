/**
 * Session auto-titling for rpc-ui tabs: the low-signal gate, and the derived
 * title sent immediately at prompt time.
 *
 * omp titles itself only in the TUI (`input-controller.ts` #maybeStartTitleGeneration);
 * `--mode=rpc-ui` never does — verified against omp v17.1.8, where a full
 * prompt/agent_end cycle leaves the title slot empty. So omp-ui titles the
 * session itself in two phases: first, the derived name goes out immediately
 * with `set_session_name` at prompt time, then `core/title-model.ts` asks omp's
 * own small model and, when it answers with a different name, the model title
 * overwrites it.
 *
 * That command lands with source `"user"`. omp (verified in 18.0.4) refuses
 * only a later `"auto"` title once a `"user"` one exists — a second
 * user-sourced rename (our phase-2 upgrade, the HUD's manual rename)
 * overwrites it, which is why phase 2 guards itself instead of relying on
 * refusal. Latching a title onto a greeting is still wrong, which is why the
 * low-signal filter below gates the very first rename — mirroring omp's own
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

/** Max title length before hard truncation, matching omp's own title width. */
const MAX_TITLE_CHARS = 60;
/** Shortest first sentence worth titling from — below this, keep reading. */
const MIN_SENTENCE_CHARS = 14;

/**
 * Fallback title, derived mechanically from the prompt: strips conversational
 * prefixes, cuts at the first real sentence boundary, else truncates on a word
 * boundary. Sent first, immediately at prompt time, so the session is named
 * before any model round trip; the model title overwrites it when it arrives
 * with a different name. It reads like a trimmed prompt, not a summary — that
 * is exactly why the model upgrade follows.
 */
export function generateTitleFromPrompt(prompt: string): string {
  // Collapse whitespace (multi-line prompts, extra spaces)
  let cleaned = prompt.replace(/\s+/g, " ").trim();

  // Strip common leading phrases that add no descriptive value
  cleaned = cleaned
    .replace(
      /^(Can you |Could you |Please |I want to |Help me |I need to |How do I |What is |Show me |Tell me |Explain )/i,
      "",
    )
    .trim();

  // First sentence-ending punctuation past MIN_SENTENCE_CHARS (then whitespace or EOS)
  let sentenceEnd = -1;
  for (const m of cleaned.matchAll(/[.!?](\s|$)/g)) {
    if (m.index >= MIN_SENTENCE_CHARS) {
      sentenceEnd = m.index;
      break;
    }
  }

  const truncated = sentenceEnd < 0 && cleaned.length > MAX_TITLE_CHARS;
  const end = sentenceEnd > 0 ? sentenceEnd + 1 : Math.min(cleaned.length, MAX_TITLE_CHARS);

  let title = cleaned.slice(0, end).trim();

  // Hard-truncated (no sentence boundary) — drop the partial last word
  if (truncated) {
    const lastSpace = title.lastIndexOf(" ");
    if (lastSpace > 0) title = title.slice(0, lastSpace);
  }

  // Trailing conjunctions signal mid-sentence truncation (loop until stable)
  let prev;
  do {
    prev = title;
    title = title.replace(/\s+(and|or|but|so|if|that|which|who|where|when|while)\s*$/i, "");
  } while (title !== prev);

  // Strip surrounding quotes before capitalizing
  title = title.replace(/^["']|["']$/g, "");

  if (title.length > 0) title = title[0]!.toUpperCase() + title.slice(1);

  // Fallback chain: cleaned title → raw prompt → placeholder
  return title || prompt.slice(0, 40).trim() || "New Session";
}
