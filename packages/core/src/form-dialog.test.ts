import { describe, expect, it } from "vitest";
import {
  formDialogResponse,
  formFieldError,
  validateFormDialog,
  type FormDialogChoiceField,
  type FormDialogTextField,
} from "./form-dialog";
import { isBlockingDialogMethod } from "./extension-dialog";

const radio = (
  name: string,
  values: string[],
  opts: Partial<FormDialogChoiceField> = {},
): FormDialogChoiceField => ({
  kind: "choice",
  name,
  multi: false,
  optionValues: values,
  other: false,
  ...opts,
});
const checks = (
  name: string,
  values: string[],
  opts: Partial<FormDialogChoiceField> = {},
): FormDialogChoiceField => ({
  kind: "choice",
  name,
  multi: true,
  optionValues: values,
  other: false,
  ...opts,
});
const text = (name: string, opts: Partial<FormDialogTextField> = {}): FormDialogTextField => ({
  kind: "text",
  name,
  ...opts,
});

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
      formDialogResponse([checks("env", ["docker", "k8s", "bare"], { other: true })], {
        env: { values: ["k8s", "docker"], other: "firecracker" },
      }),
    ).toEqual({ data: { env: ["docker", "k8s", "firecracker"] } });
  });

  it("deduplicates checked values and does not duplicate Other when it matches a checked option", () => {
    expect(
      formDialogResponse(
        [checks("env", ["docker", "docker", "k8s"], { other: true, disabledOptions: [true, false, false] })],
        { env: { values: ["docker"], other: "docker" } },
      ),
    ).toEqual({ data: { env: ["docker"] } });
  });

  it("keeps a lone checkbox a single value, with typed Other replacing it (upstream typed || values[0])", () => {
    expect(formDialogResponse([checks("agree", ["yes"], { other: true })], { agree: { values: ["yes"] } })).toEqual({
      data: { agree: "yes" },
    });
    expect(
      formDialogResponse([checks("agree", ["yes"], { other: true })], { agree: { other: "  only with a waiver  " } }),
    ).toEqual({ data: { agree: "only with a waiver" } });
  });

  it("omits unanswered controls entirely — never an empty placeholder", () => {
    const response = formDialogResponse([radio("db", ["sqlite", "pg"]), text("notes")], {
      db: {},
      notes: { text: "" },
    });
    expect(response).toEqual({ data: { notes: "" } });
  });

  it("sends a checkbox group's empty answer only once its name was touched with Other text", () => {
    expect(formDialogResponse([checks("env", ["a", "b"], { other: true })], { env: { values: [], other: "  " } })).toEqual({
      data: {},
    });
    expect(formDialogResponse([checks("env", ["a", "b"], { other: true })], { env: { values: [], other: "x" } })).toEqual({
      data: { env: ["x"] },
    });
  });

  it("coerces numeric number/range inputs to finite numbers and leaves non-numeric text as string", () => {
    expect(
      formDialogResponse(
        [
          text("replicas", { type: "number" }),
          text("ratio", { type: "range" }),
          text("emptyNum", { type: "number" }),
          text("owner", { type: "text" }),
        ],
        {
          replicas: { text: "3" },
          ratio: { text: "0.5" },
          emptyNum: { text: "" },
          owner: { text: "7" },
        },
      ),
    ).toEqual({ data: { replicas: 3, ratio: 0.5, emptyNum: "", owner: "7" } });
  });

  it("filters disabled options and supports enabled duplicate after a disabled option", () => {
    expect(
      formDialogResponse(
        [radio("tier", ["basic", "basic", "pro"], { disabledOptions: [true, false, false] })],
        { tier: { values: ["basic"] } },
      ),
    ).toEqual({ data: { tier: "basic" } });
    expect(
      formDialogResponse(
        [radio("tier", ["legacy", "pro"], { disabledOptions: [true, false] })],
        { tier: { values: ["legacy"] } },
      ),
    ).toEqual({ data: {} });
  });

  it("keeps __proto__ and Object.prototype names as ordinary enumerable keys", () => {
    const res = formDialogResponse(
      [text("__proto__", { id: "f0" }), text("constructor", { id: "f1" })],
      { f0: { text: "x" }, f1: { text: "y" } },
    );
    expect(JSON.stringify(res.data)).toBe('{"__proto__":"x","constructor":"y"}');
    expect(Object.getPrototypeOf(res.data)).toBe(Object.prototype);
  });

  it("never emits a name the selection record did not touch, whatever the form declares", () => {
    expect(formDialogResponse([radio("db", ["a"]), text("extra")], { db: { values: ["a"] } })).toEqual({
      data: { db: "a" },
    });
  });

  it("routes the form frame as a blocking dialog so it can never auto-cancel unseen", () => {
    expect(isBlockingDialogMethod("form")).toBe(true);
  });
});

describe("validateFormDialog / formFieldError (issue #1271)", () => {
  it("enforces required on radios, checkbox groups, and text fields (whitespace counts as empty)", () => {
    const fields = [
      radio("db", ["sqlite", "pg"], { id: "f0", required: true }),
      checks("env", ["docker", "k8s"], { id: "f1", required: true }),
      text("owner", { id: "f2", required: true }),
    ];
    expect(validateFormDialog(fields, { f2: { text: "   " } })).toEqual({
      f0: "Required",
      f1: "Select at least one",
      f2: "Required",
    });
    expect(
      validateFormDialog(fields, {
        f0: { values: ["pg"] },
        f1: { values: ["docker"] },
        f2: { text: "ops" },
      }),
    ).toEqual({});
  });

  it("enforces number/range bounds, minlength/maxlength, email, url, and pattern", () => {
    expect(formFieldError(text("n", { type: "number", min: 1, max: 5 }), { text: "0" })).toBe("Must be at least 1");
    expect(formFieldError(text("n", { type: "number", min: 1, max: 5 }), { text: "6" })).toBe("Must be at most 5");
    expect(formFieldError(text("n", { type: "number" }), { text: "abc" })).toBe("Enter a number");
    expect(formFieldError(text("n", { type: "number", min: 1 }), { text: "" })).toBeUndefined();
    expect(formFieldError(text("s", { minLength: 3 }), { text: "ab" })).toBe("Needs at least 3 characters");
    expect(formFieldError(text("s", { maxLength: 3 }), { text: "abcd" })).toBe("At most 3 characters");
    expect(formFieldError(text("e", { type: "email" }), { text: "nope" })).toBe("Enter an email address");
    expect(formFieldError(text("e", { type: "email" }), { text: "a@b.co" })).toBeUndefined();
    expect(formFieldError(text("u", { type: "url" }), { text: "not-a-url" })).toBe("Enter a full URL");
    expect(formFieldError(text("u", { type: "url" }), { text: "https://example.com" })).toBeUndefined();
    expect(formFieldError(text("p", { pattern: "[a-z]+" }), { text: "abc1" })).toBe("Must match [a-z]+");
    expect(formFieldError(text("p", { pattern: "[a-z]+" }), { text: "abc" })).toBeUndefined();
    // Invalid regex patterns are ignored like HTML & upstream.
    expect(formFieldError(text("p", { pattern: "[invalid" }), { text: "anything" })).toBeUndefined();
  });

  it("rejects an Other value that matches a disabled option with no enabled duplicate", () => {
    const field = radio("tier", ["legacy", "pro"], {
      other: true,
      disabledOptions: [true, false],
    });
    expect(formFieldError(field, { other: "legacy" })).toContain("disabled");
    const withEnabledDup = radio("tier", ["basic", "basic", "pro"], {
      other: true,
      disabledOptions: [true, false, false],
    });
    expect(formFieldError(withEnabledDup, { other: "basic" })).toBeUndefined();
  });
});
