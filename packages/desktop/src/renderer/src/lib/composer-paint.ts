import { magicKeywordSegments, type MagicKeyword } from "@omp-ui/core/magic-keywords";
import { keywordColors } from "./keyword-colors";
import { mentionRanges } from "./mentions";

export interface ComposerPaintRun {
  text: string;
  color?: string;
  iris?: boolean;
  keyword?: MagicKeyword;
  kwIndex?: number;
}

/** Splits draft text into keyword-color and resolved-mention paint runs. */
export function composerPaintRuns(
  text: string,
  knownPaths: ReadonlySet<string>,
  phase: number,
  firing: ReadonlySet<MagicKeyword>,
): ComposerPaintRun[] {
  const mentions = mentionRanges(text, knownPaths);
  const out: ComposerPaintRun[] = [];
  let base = 0;
  let mentionIndex = 0;
  for (const segment of magicKeywordSegments(text, firing)) {
    if (segment.keyword !== null) {
      const kw = segment.keyword;
      keywordColors(kw, phase).forEach((color, index) => {
        out.push({ text: segment.text[index]!, color, keyword: kw, kwIndex: index });
      });
    } else {
      const segmentStart = base;
      const segmentEnd = base + segment.text.length;
      while (
        mentionIndex < mentions.length &&
        mentions[mentionIndex]!.to <= segmentStart
      ) {
        mentionIndex += 1;
      }
      let position = 0;
      for (
        let index = mentionIndex;
        index < mentions.length && mentions[index]!.from < segmentEnd;
        index += 1
      ) {
        const from = Math.max(mentions[index]!.from, segmentStart) - segmentStart;
        const to = Math.min(mentions[index]!.to, segmentEnd) - segmentStart;
        if (from > position) out.push({ text: segment.text.slice(position, from) });
        out.push({ text: segment.text.slice(from, to), iris: true });
        position = to;
      }
      if (position < segment.text.length) {
        out.push({ text: segment.text.slice(position) });
      }
    }
    base += segment.text.length;
  }
  return out;
}
