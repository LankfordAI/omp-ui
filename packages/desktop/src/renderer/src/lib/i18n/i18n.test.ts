import { afterEach, describe, expect, it } from "vitest";
import {
  applyLocale,
  currentLocaleId,
  localeTag,
  resolveLocale,
  subscribe,
  t,
  UI_LOCALES,
} from "./index";
import { en } from "./en";
import { ko } from "./ko";
import type { MessageKey } from "./types";

const KEY_PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

const placeholders = (value: string): string[] => {
  const found = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  return [...new Set(found)].sort();
};

// The catalogs are frozen-shaped (en is `as const`); these casts are the
// test seam for adding and removing a throwaway key without touching the
// real catalog.
const enCatalog = en as unknown as Record<string, string | undefined>;
const koCatalog = ko as Record<string, string | undefined>;

describe("resolveLocale", () => {
  it("degrades every unknown or empty id to the default locale", () => {
    expect(resolveLocale(undefined).id).toBe("en");
    expect(resolveLocale("").id).toBe("en");
    expect(resolveLocale("xx").id).toBe("en");
    expect(resolveLocale("ko").id).toBe("ko");
  });
});

describe("t()", () => {
  const KEY = "settings.general.language" as MessageKey;

  it("returns the English catalog under the default locale", () => {
    applyLocale(resolveLocale("en"));
    expect(t(KEY)).toBe(en[KEY]);
    expect(t(KEY)).not.toBe(ko[KEY]);
  });

  it("returns the Korean catalog under the Korean locale", () => {
    applyLocale(resolveLocale("ko"));
    expect(t(KEY)).toBe(ko[KEY]);
  });

  it("switches with the active locale: a ko-translated key is English until ko is applied", () => {
    applyLocale(resolveLocale("en"));
    expect(t(KEY)).toBe(en[KEY]);
    applyLocale(resolveLocale("ko"));
    expect(t(KEY)).toBe(ko[KEY]!);
    applyLocale(resolveLocale("en"));
    expect(t(KEY)).toBe(en[KEY]);
  });

  it("falls back to English for a key the Korean catalog lacks", () => {
    const saved = ko[KEY];
    delete ko[KEY];
    try {
      applyLocale(resolveLocale("ko"));
      expect(t(KEY)).toBe(en[KEY]);
    } finally {
      ko[KEY] = saved;
    }
  });

  it("substitutes {var} placeholders in the active locale and blanks vars that were not passed", () => {
    const key = "transcript.queuedCount";
    enCatalog[key] = "parked: {n} of {total}";
    koCatalog[key] = "대기: {n} / {total}";
    try {
      applyLocale(resolveLocale("en"));
      expect(t(key as MessageKey, { n: 2, total: 5 })).toBe("parked: 2 of 5");
      expect(t(key as MessageKey, { n: 2 })).toBe("parked: 2 of ");
      applyLocale(resolveLocale("ko"));
      expect(t(key as MessageKey, { n: 2, total: 5 })).toBe("대기: 2 / 5");
    } finally {
      delete enCatalog[key];
      delete koCatalog[key];
    }
  });

  it("notifies subscribers and updates currentLocaleId on applyLocale", () => {
    const seen: string[] = [];
    applyLocale(resolveLocale("en"));
    const unsubscribe = subscribe(() => {
      seen.push(currentLocaleId());
    });
    applyLocale(resolveLocale("ko"));
    unsubscribe();
    applyLocale(resolveLocale("en"));
    expect(currentLocaleId()).toBe("en");
    expect(seen).toEqual(["ko"]);
  });
});

afterEach(() => {
  // Locale state is module-global; every test starts from the default.
  applyLocale(resolveLocale("en"));
});

describe("catalog hygiene", () => {
  it("keeps every catalog value plain text: no angle brackets", () => {
    for (const [catalog, name] of [[enCatalog, "en"], [koCatalog, "ko"]] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value !== undefined && (value.includes("<") || value.includes(">")), `${name}:${key}`).toBe(false);
      }
    }
  });

  it("names every English key <area>.<surface>.<thing>", () => {
    for (const key of Object.keys(enCatalog)) {
      expect(key, key).toMatch(KEY_PATTERN);
    }
  });

  it("keeps {var} placeholder parity between the English and Korean catalogs", () => {
    for (const [key, value] of Object.entries(koCatalog)) {
      const english = enCatalog[key];
      expect(english, `en value for ${key}`).toBeDefined();
      expect(placeholders(value!), key).toEqual(placeholders(english!));
    }
  });

  it("knows both locales with BCP-47 tags", () => {
    expect(UI_LOCALES.map((l) => l.id)).toEqual(["en", "ko"]);
    expect(UI_LOCALES.map((l) => l.tag)).toEqual(["en", "ko"]);
  });

  it("reports the active locale's BCP-47 tag", () => {
    applyLocale(resolveLocale("ko"));
    expect(localeTag()).toBe("ko");
    applyLocale(resolveLocale("en"));
    expect(localeTag()).toBe("en");
  });
});
