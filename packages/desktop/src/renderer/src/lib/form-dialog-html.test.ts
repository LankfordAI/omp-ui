// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseFormHtml, spansPlainText } from "./form-dialog-html";

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
    expect(group.field.other).toBe(true);
    expect(group.options.map(o => [o.value, o.checked])).toEqual([
      ["sqlite", true],
      ["pg", false],
    ]);
  });

  it("does not add Other when the form already offers one (including 'Other (specify)')", () => {
    const parsed = parseFormHtml(
      '<label><input type="checkbox" name="env" value="docker"> docker</label>' +
        '<label><input type="checkbox" name="env" value="k8s"> k8s</label>' +
        '<label><input type="checkbox" name="env" value="other"> Other (specify)</label>',
    );
    const group = parsed.fields[0]!;
    if (group.kind !== "choice") throw new Error("expected a choice group");
    expect(group.field.other).toBe(false);
    expect(group.field.multi).toBe(true);
  });

  it("never adds Other to <select> controls and defaults single select to its first enabled option", () => {
    const parsed = parseFormHtml(
      '<label>Region <select name="region"><option value="old" disabled>Old</option><option value="us">US</option><option value="eu">EU</option></select></label>' +
        '<select name="tags" multiple><option value="a">A</option><option value="b">B</option></select>',
    );
    const [single, multi] = parsed.fields;
    if (single?.kind !== "choice" || multi?.kind !== "choice") throw new Error("expected choice groups");
    expect(single.label).toBe("Region");
    expect(single.field.select).toBe(true);
    expect(single.field.other).toBe(false);
    expect(single.options.map(o => [o.value, o.checked, o.disabled])).toEqual([
      ["old", false, true],
      ["us", true, false],
      ["eu", false, false],
    ]);
    expect(multi.field.select).toBe(true);
    expect(multi.field.multi).toBe(true);
    expect(multi.field.other).toBe(false);
  });

  it("keeps one-option groups without the free-text affordance", () => {
    const parsed = parseFormHtml('<label><input type="radio" name="pick" value="a"> A</label>');
    const group = parsed.fields[0]!;
    if (group.kind !== "choice") throw new Error("expected a choice group");
    expect(group.field.other).toBe(false);
  });

  it("keeps radio and checkbox groups separate even when they share a name", () => {
    const parsed = parseFormHtml(
      '<label><input type="radio" name="pick" value="a"> A</label>' +
        '<label><input type="radio" name="pick" value="b"> B</label>' +
        '<label><input type="checkbox" name="pick" value="x"> X</label>' +
        '<label><input type="checkbox" name="pick" value="y"> Y</label>',
    );
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0]?.kind === "choice" && parsed.fields[0].field.multi).toBe(false);
    expect(parsed.fields[1]?.kind === "choice" && parsed.fields[1].field.multi).toBe(true);
    expect(parsed.fields[0]?.field.id).not.toBe(parsed.fields[1]?.field.id);
  });

  it("ignores content outside the first <form> when one exists", () => {
    const parsed = parseFormHtml(
      '<p>Outside</p><input name="outside"><form><p>Inside</p><label>Keep <input name="inside"></label></form><input name="after">',
    );
    expect(parsed.intro).toBe("Inside");
    expect(parsed.fields.map(f => f.field.name)).toEqual(["inside"]);
  });

  it("reads text inputs, constraints, <label for>, and textareas with their prefill", () => {
    const parsed = parseFormHtml(
      '<form><label for="ttl">TTL days</label><input id="ttl" type="number" name="ttl" value="30" min="1" max="90" required>' +
        '<label>Email <input type="email" name="email" placeholder="a@b.com" minlength="3" maxlength="40" pattern=".+@.+"></label>' +
        '<textarea name="notes" rows="7">\nkeep one file</textarea></form>',
    );
    const [ttl, email, notes] = parsed.fields;
    if (ttl?.kind !== "text" || email?.kind !== "text" || notes?.kind !== "text") {
      throw new Error("expected text fields");
    }
    expect(ttl.label).toBe("TTL days");
    expect(ttl.field.type).toBe("number");
    expect(ttl.field.min).toBe(1);
    expect(ttl.field.max).toBe(90);
    expect(ttl.field.required).toBe(true);
    expect(ttl.value).toBe("30");
    expect(email.field.type).toBe("email");
    expect(email.field.minLength).toBe(3);
    expect(email.field.maxLength).toBe(40);
    expect(email.field.pattern).toBe(".+@.+");
    expect(email.placeholder).toBe("a@b.com");
    expect(notes.multiline).toBe(true);
    expect(notes.rows).toBe(7);
    expect(notes.value).toBe("keep one file");
  });

  it("drops hidden, file, image, button, reset, and submit controls from the answer surface", () => {
    const parsed = parseFormHtml(
      '<input type="hidden" name="tok" value="x">' +
        '<input type="file" name="f">' +
        '<input type="image" name="img" src="x.png">' +
        '<input type="reset" name="r">' +
        '<input type="button" name="b">' +
        '<input name="why">' +
        '<input type="submit" value="send">',
    );
    expect(parsed.fields.map(f => f.field.name)).toEqual(["why"]);
  });

  it("preserves fieldsets, lists, pre blocks, and context tables in document order", () => {
    const parsed = parseFormHtml(
      `<form>
        <p>Compare options:</p>
        <table><thead><tr><th>Store</th><th>Ops</th></tr></thead><tbody><tr><td><code>sqlite</code></td><td>None</td></tr></tbody></table>
        <ul><li><strong>Fast</strong> local file</li></ul>
        <pre>SELECT 1;</pre>
        <fieldset>
          <legend>Choice</legend>
          <label><input type="radio" name="db" value="sqlite" checked> SQLite</label>
          <label><input type="radio" name="db" value="pg"> Postgres</label>
        </fieldset>
      </form>`,
    );
    expect(parsed.sections).toHaveLength(2);
    const loose = parsed.sections[0]!;
    expect(loose.blocks.map(b => b.kind)).toEqual(["text", "table", "list", "pre"]);
    const table = loose.blocks[1]!;
    expect(table.kind === "table" && table.headerRows).toBe(1);
    const fieldset = parsed.sections[1]!;
    expect(fieldset.fieldset).toBe(true);
    expect(spansPlainText(fieldset.title)).toBe("Choice");
  });

  it("strips active/network content and only admits raster base64 data URI images", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const parsed = parseFormHtml(
      `<form>
        <script>window.__pwned = true;</script>
        <style>body { display: none; }</style>
        <iframe src="https://evil.example"></iframe>
        <object data="https://evil.example/x"></object>
        <embed src="https://evil.example/y">
        <img src="https://evil.example/pixel.png" alt="remote pic" onerror="alert(1)">
        <img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg data">
        <img src="${png}" alt="safe png">
        <svg aria-label="diagram"><script>alert(1)</script></svg>
        <p onclick="alert(1)">Hello</p>
        <label><input name="ok" onfocus="alert(1)"> Answer</label>
      </form>`,
    );
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    const blocks = parsed.sections[0]!.blocks;
    const images = blocks.filter(b => b.kind === "image");
    expect(images).toEqual([
      { kind: "image", safeDataSrc: null, alt: "remote pic" },
      { kind: "image", safeDataSrc: null, alt: "svg data" },
      { kind: "image", safeDataSrc: png, alt: "safe png" },
      { kind: "image", safeDataSrc: null, alt: "diagram" },
    ]);
    expect(parsed.fields.map(f => f.field.name)).toEqual(["ok"]);
  });

  it("never executes form scripts and survives junk", () => {
    const parsed = parseFormHtml("<script>alert(1)</script><p>hi");
    expect(parsed.fields).toEqual([]);
    expect(parseFormHtml(undefined)).toEqual({ intro: "", sections: [], fields: [] });
    expect(parseFormHtml("")).toEqual({ intro: "", sections: [], fields: [] });
  });
});
