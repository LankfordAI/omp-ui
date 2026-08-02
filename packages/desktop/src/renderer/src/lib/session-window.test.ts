import { describe, expect, it } from "vitest";
import { PAGE, sessionWindow } from "./session-window";

/** The active session is elsewhere (or there is none) — no widening. */
const NO_ACTIVE = -1;

describe("sessionWindow", () => {
  it("shows one page and reports the rest as remaining", () => {
    expect(sessionWindow(43, PAGE, NO_ACTIVE)).toEqual({ shown: 8, remaining: 35 });
  });

  it("shows every session once the list fits inside the window", () => {
    expect(sessionWindow(5, PAGE, NO_ACTIVE)).toEqual({ shown: 5, remaining: 0 });
  });

  it("clamps to the list length, so remaining never goes negative", () => {
    // A user who paged to the end, then had sessions disappear under them.
    expect(sessionWindow(3, 40, NO_ACTIVE)).toEqual({ shown: 3, remaining: 0 });
  });

  it("handles an empty project without producing a negative window", () => {
    expect(sessionWindow(0, PAGE, NO_ACTIVE)).toEqual({ shown: 0, remaining: 0 });
  });

  it("widens to keep an active session past the window visible", () => {
    // Index 19 is the 20th row: hiding it would drop the selection highlight.
    expect(sessionWindow(43, PAGE, 19)).toEqual({ shown: 20, remaining: 23 });
  });

  it("leaves the window alone when the active session already fits", () => {
    expect(sessionWindow(43, PAGE, 2)).toEqual({ shown: 8, remaining: 35 });
  });

  it("never shrinks the window the user opened to reach the active session", () => {
    // Paged to 24 with the active row at index 1 — widening must not pull back.
    expect(sessionWindow(43, 24, 1)).toEqual({ shown: 24, remaining: 19 });
  });

  it("widens to the last row when the active session sits at the very end", () => {
    expect(sessionWindow(43, PAGE, 42)).toEqual({ shown: 43, remaining: 0 });
  });
});
