import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickSpellcheckLanguages, setupSpellcheck } from "./spellcheck";

interface CapturedItem {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
}

// The real module imports electron; stub the menu surface and the locale.
// vi.mock is hoisted above the static import of ./spellcheck, so the module
// under test sees these doubles. The factory must not touch the lets below —
// only the class methods may, and they run after module evaluation.
let menuItems: CapturedItem[] = [];
let popupCount = 0;
vi.mock("electron", () => ({
  app: { getLocale: () => "en-GB" },
  Menu: class {
    append(item: CapturedItem) {
      menuItems.push(item);
    }
    popup() {
      popupCount += 1;
    }
  },
  MenuItem: class {
    constructor(opts: CapturedItem) {
      Object.assign(this, opts);
    }
  },
}));

interface ContextMenuParams {
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: string[];
}

type ContextMenuHandler = (event: unknown, params: ContextMenuParams) => void;
type LoadHandler = () => void;

interface FakeCalls {
  enabled: boolean[];
  languages: string[][];
  added: string[];
  replaced: string[];
  order: string[];
}

interface FakeHarness {
  win: {
    webContents: {
      session: {
        availableSpellCheckerLanguages: string[];
        setSpellCheckerEnabled: (b: boolean) => void;
        setSpellCheckerLanguages: (l: string[]) => void;
        addWordToSpellCheckerDictionary: (w: string) => void;
        on: (event: string, fn: (e: unknown, code: string) => void) => void;
      };
      on: (event: string, fn: ContextMenuHandler | LoadHandler) => void;
      replaceMisspelling: (s: string) => void;
    };
  };
  calls: FakeCalls;
  fire: (params: ContextMenuParams) => void;
  load: () => void;
}

function fakeWin(available: string[]): FakeHarness {
  const calls: FakeCalls = {
    enabled: [],
    languages: [],
    added: [],
    replaced: [],
    order: [],
  };
  let onContextMenu: ContextMenuHandler | null = null;
  let onLoad: LoadHandler | null = null;
  const win: FakeHarness["win"] = {
    webContents: {
      session: {
        availableSpellCheckerLanguages: available,
        setSpellCheckerEnabled: (b) => {
          calls.enabled.push(b);
          calls.order.push(`enabled:${b}`);
        },
        setSpellCheckerLanguages: (l) => {
          calls.languages.push(l);
          calls.order.push(`languages:${l.join(",")}`);
        },
        addWordToSpellCheckerDictionary: (w) => void calls.added.push(w),
        on: () => {},
      },
      on: (event, fn) => {
        if (event === "context-menu") onContextMenu = fn as ContextMenuHandler;
        if (event === "did-finish-load") onLoad = fn as LoadHandler;
      },
      replaceMisspelling: (s) => void calls.replaced.push(s),
    },
  };
  return {
    win,
    calls,
    fire: (params) => onContextMenu?.(null, params),
    load: () => onLoad?.(),
  };
}

function setup(h: FakeHarness): FakeHarness {
  setupSpellcheck(h.win as unknown as BrowserWindow);
  return h;
}

beforeEach(() => {
  menuItems = [];
  popupCount = 0;
});

describe("pickSpellcheckLanguages", () => {
  it("prefers the exact locale", () => {
    expect(pickSpellcheckLanguages(["fr", "en-US"], "en-US")).toEqual(["en-US"]);
  });

  it("falls back to a sibling of the same base language", () => {
    expect(pickSpellcheckLanguages(["en-US", "fr"], "en-GB")).toEqual(["en-US"]);
  });

  it("falls back to en-US when the locale matches nothing", () => {
    expect(pickSpellcheckLanguages(["de-DE", "en-US"], "ja-JP")).toEqual(["en-US"]);
  });

  it("falls back to the first available language without en-US", () => {
    expect(pickSpellcheckLanguages(["de-DE", "fr"], "ja-JP")).toEqual(["de-DE"]);
  });

  it("yields nothing when the platform offers nothing (macOS)", () => {
    expect(pickSpellcheckLanguages([], "en-US")).toEqual([]);
  });
});

describe("setupSpellcheck", () => {
  it("rebinds the checker and locale-derived language after renderer load", () => {
    const h = setup(fakeWin(["en-US", "fr"]));
    expect(h.calls.order).toEqual([]);
    h.load();
    // Mocked locale is en-GB; en-US is its base-language sibling.
    expect(h.calls.order).toEqual(["enabled:false", "enabled:true", "languages:en-US"]);
  });

  it("sets no languages when the platform offers none", () => {
    const h = setup(fakeWin([]));
    h.load();
    expect(h.calls.enabled).toEqual([false, true]);
    expect(h.calls.languages).toEqual([]);
  });

  it("rebinds the checker after every renderer reload", () => {
    const h = setup(fakeWin(["en-US"]));
    h.load();
    h.load();
    expect(h.calls.order).toEqual([
      "enabled:false",
      "enabled:true",
      "languages:en-US",
      "enabled:false",
      "enabled:true",
      "languages:en-US",
    ]);
  });

  it("shows no menu outside editable fields", () => {
    const { fire } = setup(fakeWin(["en-US"]));
    fire({ isEditable: false, misspelledWord: "teh", dictionarySuggestions: ["the"] });
    expect(popupCount).toBe(0);
  });

  it("shows no menu without a misspelled word", () => {
    const { fire } = setup(fakeWin(["en-US"]));
    fire({ isEditable: true, misspelledWord: "", dictionarySuggestions: [] });
    expect(popupCount).toBe(0);
  });

  it("offers suggestions that replace the misspelling", () => {
    const { calls, fire } = setup(fakeWin(["en-US"]));
    fire({ isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "tech"] });
    expect(popupCount).toBe(1);
    const labels = menuItems.map((i) => i.label ?? i.type);
    expect(labels).toEqual(["the", "tech", "separator", "Add to dictionary"]);
    menuItems[0]!.click!();
    expect(calls.replaced).toEqual(["the"]);
  });

  it("adds the misspelled word to the dictionary", () => {
    const { calls, fire } = setup(fakeWin(["en-US"]));
    fire({ isEditable: true, misspelledWord: "jsonl", dictionarySuggestions: [] });
    expect(popupCount).toBe(1);
    const disabled = menuItems.find((i) => i.label === "No spelling suggestions");
    expect(disabled?.enabled).toBe(false);
    menuItems.find((i) => i.label === "Add to dictionary")!.click!();
    expect(calls.added).toEqual(["jsonl"]);
  });
});
