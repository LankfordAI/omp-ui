import { describe, expect, it } from "vitest";
import { formDialogResponse } from "./form-dialog";
import { isBlockingDialogMethod } from "./extension-dialog";

const radio = (name: string, values: string[], other = false) => ({
  kind: "choice" as const,
  name,
  multi: false,
  optionValues: values,
  other,
});
const checks = (name: string, values: string[], other = false) => ({
  kind: "choice" as const,
  name,
  multi: true,
  optionValues: values,
  other,
});
const text = (name: string) => ({ kind: "text" as const, name });

describe("formDialogResponse (issue #1271)", () => {
  it("keys the answer by control name as an HTML form submits", () => {
    expect(
      formDialogResponse([radio("db", ["sqlite", "pg"]), text("notes")], {
        db: { values: ["pg"] },
        notes: { text: "lock to one file" },
      }),
    ).toEqual({ data: { db: "pg", notes: "lock to one file" } });
  });

  it("ships a multi-select with two or more options as an array in document order, Other last", () => {
    expect(
      formDialogResponse([checks("env", ["docker", "k8s", "bare"], true)], {
        env: { values: ["k8s", "docker"], other: "firecracker" },
      }),
    ).toEqual({ data: { env: ["docker", "k8s", "firecracker"] } });
  });

  it("keeps a lone checkbox a single value, with typed Other replacing it (upstream typed || values[0])", () => {
    expect(formDialogResponse([checks("agree", ["yes"], true)], { agree: { values: ["yes"] } })).toEqual({
      data: { agree: "yes" },
    });
    expect(
      formDialogResponse([checks("agree", ["yes"], true)], { agree: { other: "  only with a waiver  " } }),
    ).toEqual({ data: { agree: "only with a waiver" } });
  });

  it("omits unanswered controls entirely — never an empty placeholder", () => {
    const response = formDialogResponse([radio("db", ["sqlite", "pg"]), text("notes")], {
      db: {},
      notes: { text: "" },
    });
    // An empty textarea is still a submitted empty string, like HTML; an
    // untouched choice carries no key at all.
    expect(response).toEqual({ data: { notes: "" } });
  });

  it("sends a checkbox group's empty answer only once its name was touched with Other text", () => {
    expect(formDialogResponse([checks("env", ["a", "b"], true)], { env: { values: [], other: "  " } })).toEqual({
      data: {},
    });
    expect(formDialogResponse([checks("env", ["a", "b"], true)], { env: { values: [], other: "x" } })).toEqual({
      data: { env: ["x"] },
    });
  });

  it("never emits a name the selection record did not touch, whatever the form declares", () => {
    // omp throws on unknown keys; only fields with an answer may appear.
    expect(formDialogResponse([radio("db", ["a"]), text("extra")], { db: { values: ["a"] } })).toEqual({
      data: { db: "a" },
    });
  });

  it("routes the form frame as a blocking dialog so it can never auto-cancel unseen", () => {
    expect(isBlockingDialogMethod("form")).toBe(true);
  });
});
