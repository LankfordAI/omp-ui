// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseFormHtml } from "./form-dialog-html";

describe("parseFormHtml (issue #1271)", () => {
  it("reads a radio group with its options, defaults and host-added Other", () => {
    const parsed = parseFormHtml(
      "<p>Which store?</p>" +
        '<label><input type="radio" name="db" value="sqlite" checked> SQLite</label>' +
        '<label><input type="radio" name="db" value="pg"> Postgres</label>',
    );
    expect(parsed.intro).toBe("Which store?");
    expect(parsed.fields).toHaveLength(1);
    const group = parsed.fields[0]!;
    expect(group.kind).toBe("choice");
    if (group.kind !== "choice") return;
    expect(group.field.name).toBe("db");
    expect(group.field.multi).toBe(false);
    expect(group.field.optionValues).toEqual(["sqlite", "pg"]);
    // Two options without their own "Other": the host adds free text.
    expect(group.field.other).toBe(true);
    expect(group.options.map(o => [o.value, o.checked])).toEqual([
      ["sqlite", true],
      ["pg", false],
    ]);
  });

  it("does not add Other when the form already offers one", () => {
    const parsed = parseFormHtml(
      '<label><input type="checkbox" name="env" value="docker"> docker</label>' +
        '<label><input type="checkbox" name="env" value="k8s"> k8s</label>' +
        '<label><input type="checkbox" name="env" value="other"> Other</label>',
    );
    const group = parsed.fields[0]!;
    if (group.kind !== "choice") throw new Error("expected a choice group");
    expect(group.field.other).toBe(false);
    expect(group.field.multi).toBe(true);
  });

  it("keeps one-option groups without the free-text affordance", () => {
    const parsed = parseFormHtml('<label><input type="radio" name="pick" value="a"> A</label>');
    const group = parsed.fields[0]!;
    if (group.kind !== "choice") throw new Error("expected a choice group");
    expect(group.field.other).toBe(false);
  });

  it("reads text inputs and textareas with their prefill", () => {
    const parsed = parseFormHtml(
      '<label>DSN <input name="dsn" value="postgres://x"></label>' +
        "<textarea name=\"notes\" rows=\"7\">keep one file</textarea>",
    );
    const [dsn, notes] = parsed.fields;
    if (dsn?.kind !== "text" || notes?.kind !== "text") throw new Error("expected text fields");
    expect(dsn.field.name).toBe("dsn");
    expect(dsn.value).toBe("postgres://x");
    expect(dsn.multiline).toBe(false);
    expect(notes.field.name).toBe("notes");
    expect(notes.multiline).toBe(true);
    expect(notes.rows).toBe(7);
    expect(notes.value).toBe("keep one file");
  });

  it("drops hidden and submit controls from the answer surface", () => {
    const parsed = parseFormHtml(
      '<input type="hidden" name="tok" value="x">' +
        '<input name="why">' +
        '<input type="submit" value="send">',
    );
    expect(parsed.fields.map(f => f.field.name)).toEqual(["why"]);
  });

  it("reads select groups, multiple included", () => {
    const parsed = parseFormHtml(
      '<select name="m"><option value="a">A</option><option value="b" selected>B</option></select>' +
        '<select name="s" multiple><option value="c">C</option></select>',
    );
    const [single, multi] = parsed.fields;
    if (single?.kind !== "choice" || multi?.kind !== "choice") throw new Error("expected choice groups");
    expect(single.field.multi).toBe(false);
    expect(single.options[1]?.checked).toBe(true);
    expect(multi.field.multi).toBe(true);
  });

  it("never executes form scripts and survives junk", () => {
    const parsed = parseFormHtml('<script>alert(1)</script><p>hi');
    expect(parsed.fields).toEqual([]);
    expect(parseFormHtml(undefined)).toEqual({ intro: "", fields: [] });
    expect(parseFormHtml("")).toEqual({ intro: "", fields: [] });
  });
});
