import { app, Menu, MenuItem, type BrowserWindow } from "electron";

/**
 * Spellcheck for the composer and the other prose textareas (issue #24).
 *
 * Electron ships Chromium's checker (Hunspell on Linux, the OS checker on
 * macOS/Windows) and the `spellcheck` webPreference already defaults to on,
 * so the two missing pieces are language selection and a corrections UI:
 * Electron renders no default context menu, so without one a misspelled word
 * underlines but right-click does nothing.
 */

/**
 * The languages to enable, picked from what the platform checker actually
 * offers. Exact locale first ("en-GB"), then a sibling of the same base
 * language ("en-GB" → "en-US"), then en-US, then whatever exists. An empty
 * `available` (macOS, where the OS checker auto-detects and reports nothing)
 * yields no languages — callers must skip setSpellCheckerLanguages then.
 */
export function pickSpellcheckLanguages(available: string[], locale: string): string[] {
  const lower = available.map((l) => l.toLowerCase());
  const exact = lower.indexOf(locale.toLowerCase());
  if (exact >= 0) return [available[exact]!];
  const base = locale.split("-")[0]?.toLowerCase();
  if (base) {
    const sibling = lower.findIndex((l) => l.split("-")[0] === base);
    if (sibling >= 0) return [available[sibling]!];
  }
  const enUS = lower.indexOf("en-us");
  if (enUS >= 0) return [available[enUS]!];
  return available.length > 0 ? [available[0]!] : [];
}

/**
 * Installs spellcheck for every renderer load and the corrections context
 * menu. A cached dictionary needs an explicit disabled → enabled transition
 * after navigation or Chromium leaves the new renderer without a checker.
 */
export function setupSpellcheck(win: BrowserWindow): void {
  const ses = win.webContents.session;
  const languages = pickSpellcheckLanguages(ses.availableSpellCheckerLanguages, app.getLocale());

  // Linux/Windows hunspell dictionaries download on first use; make that
  // visible in the dev-server terminal instead of failing silently.
  ses.on("spellcheck-dictionary-download-begin", (_e, code) => {
    console.info(`[spellcheck] downloading dictionary: ${code}`);
  });
  ses.on("spellcheck-dictionary-download-success", (_e, code) => {
    console.info(`[spellcheck] dictionary downloaded: ${code}`);
  });
  ses.on("spellcheck-dictionary-download-failure", (_e, code) => {
    console.warn(`[spellcheck] dictionary download FAILED: ${code}`);
  });
  ses.on("spellcheck-dictionary-initialized", (_e, code) => {
    console.info(`[spellcheck] dictionary ready: ${code}`);
  });

  win.webContents.on("did-finish-load", () => {
    // Electron 43 does not bind an already-cached dictionary to a newly loaded
    // renderer when these values are unchanged. Force a state transition so
    // the loaded textarea receives the checker; repeat on hard reloads.
    ses.setSpellCheckerEnabled(false);
    ses.setSpellCheckerEnabled(true);
    if (languages.length > 0) ses.setSpellCheckerLanguages(languages);
    console.info(
      `[spellcheck] enabled, languages: ${languages.length > 0 ? languages.join(", ") : "platform-managed"}`,
    );
  });

  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable || !params.misspelledWord) return;
    const word = params.misspelledWord;
    const menu = new Menu();
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        }),
      );
    }
    if (params.dictionarySuggestions.length === 0) {
      menu.append(new MenuItem({ label: "No spelling suggestions", enabled: false }));
    }
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: "Add to dictionary",
        click: () => ses.addWordToSpellCheckerDictionary(word),
      }),
    );
    menu.popup();
  });
}
