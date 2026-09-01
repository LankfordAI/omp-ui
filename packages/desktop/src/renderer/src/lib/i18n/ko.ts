import type { MessageKey } from "./types";

/**
 * Korean catalog (issue #363). Partial on purpose: any key missing here
 * falls back to English at runtime. DRAFTS — every string requires
 * native-speaker review before release.
 */
export const ko: Partial<Record<MessageKey, string>> = {
  "settings.general.language": "언어",
  "settings.general.languageHint":
    "응용 프로그램 외곽의 언어입니다. 세션 내용과 터미널 출력은 번역되지 않습니다.",
};
