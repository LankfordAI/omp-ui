/**
 * The brief activity label of a tool intent (issue #1274). omp 19.1's
 * `pi-wire` added `toolIntentLabel`: while activity streams, surfaces show
 * the label part of an intent and keep the full text for output and ranking.
 * The rule is upstream's verbatim: the label is the text before the first
 * colon followed by whitespace or end-of-string. A bare intent has no such
 * colon and stays whole; an empty slice never wins; colons embedded in a URL
 * or a `file:line` reference — not followed by whitespace — are not
 * separators, so `Reading config.json: 3 lines` reads as `Reading config.json`
 * while `Fetched https://ex.com:8080/x` keeps its authority port.
 */

/** The activity label of a tool intent; the intent itself when it has none. */
export function toolIntentLabel(intent: string): string {
  const separator = intent.search(/:(?=\s|$)/);
  return separator > 0 ? intent.slice(0, separator).trim() || intent : intent;
}
