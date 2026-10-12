/**
 * omp 18.8.7+ composes title cards into the title string itself:
 * `${icon} ${code}: ${title}` (verified in the 18.8.9 binary — the card
 * rides no frame or registry field; the session-file scanner already
 * carries it inside `SessionSummary.title`). This module recognizes that
 * shape at display time and splits it for the sidebar row. Pure — zero
 * imports — so the renderer imports it directly via the subpath, exactly
 * like worktree-branch.ts.
 */

export interface TitleCard {
  /** Emoji-only display icon; null when the icon was PUA-only or absent. */
  icon: string | null;
  /** The short code, e.g. "PLAN". */
  code: string;
  /** The human title without card decorations. */
  title: string;
}

/** Private-use areas: Nerd Font glyphs live here and would render tofu in
 *  the renderer's emoji-only font stack (only Pretendard is bundled). */
const PUA = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/** `${icon} ${CODE}: ${title}` — icon is one non-space token, code is
 *  uppercase alphanumeric starting with a letter, title is non-empty. */
const CARD = /^(\S+?) ([A-Z][A-Z0-9]{1,9}): (\S.*)$/;

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PUA_TEST = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

/**
 * Split an omp title card out of a raw session title, or return null when
 * the string is not a card — every plain title, every `title.icons: boring`
 * title, and every pre-18.8.7 title renders unchanged.
 */
export function parseTitleCard(raw: string): TitleCard | null {
  // The registry's `pad` slot can leave trailing whitespace on the string.
  const match = CARD.exec(raw.trim());
  if (match === null) return null;
  const iconToken = match[1]!;
  // The first token of a real card is always an icon, never a plain ASCII
  // word — this kills false positives like "HTTP: a primer". A short code
  // alone is never a card.
  if (!EMOJI_PRESENTATION.test(iconToken) && !PUA_TEST.test(iconToken)) return null;
  const icon = iconToken.replace(PUA, "");
  return {
    icon: icon === "" ? null : icon,
    code: match[2]!,
    title: match[3]!,
  };
}
