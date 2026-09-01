/**
 * English catalog — the source of truth (issue #363). Plain text only: no
 * HTML, no angle brackets. {var} placeholders are substituted by t().
 * Surface by surface the rest of the chrome fills this in.
 */
export const en = {
  "settings.general.language": "Language",
  "settings.general.languageHint":
    "The language of the application chrome. Session content and terminal output are never translated.",
} as const;
