import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advisorOverlayPath, writeAdvisorOverlay } from "./advisor-overlay";
import {
  base64Bytes,
  bracketedImagePaste,
  imageExtension,
  isSupportedImageMime,
  writeImageToScratch,
} from "./images";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-img-"));
  tmpDirs.push(dir);
  return dir;
}

const scratched: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const file of scratched.splice(0)) fs.rmSync(file, { force: true });
});

describe("base64Bytes", () => {
  it("matches the decoded length without decoding", () => {
    for (const text of ["", "a", "ab", "abc", "abcd", "hello world, a longer payload"]) {
      const b64 = Buffer.from(text).toString("base64");
      expect(base64Bytes(b64)).toBe(Buffer.byteLength(text));
    }
  });
});

describe("imageExtension", () => {
  it("maps omp's four accepted types", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/gif")).toBe("gif");
    expect(imageExtension("image/webp")).toBe("webp");
  });

  it("falls back to png, which omp's paste detector accepts", () => {
    // An unknown type must still land on an extension omp recognises, or the
    // bracketed paste degrades to literal text in the prompt.
    expect(imageExtension("image/bmp")).toBe("png");
    expect(isSupportedImageMime("image/bmp")).toBe(false);
  });
});

describe("writeImageToScratch", () => {
  it("writes decoded bytes under an extension omp will detect", () => {
    const data = Buffer.from("not really a png, but the bytes must round-trip");
    const file = writeImageToScratch({
      type: "image",
      data: data.toString("base64"),
      mimeType: "image/png",
    });
    scratched.push(file);
    expect(file.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(file)).toEqual(data);
  });

  it("never reuses a name, so two pastes cannot clobber each other", () => {
    const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
    const a = writeImageToScratch(image);
    const b = writeImageToScratch(image);
    scratched.push(a, b);
    expect(a).not.toBe(b);
  });
});

describe("bracketedImagePaste", () => {
  it("wraps the path in the markers omp's TUI editor scans", () => {
    // Verified against omp v17.1.8 `extractBracketedImagePastePath`, which
    // requires the payload to be exactly the markers plus one explicit path.
    expect(bracketedImagePaste("/tmp/omp-ui-paste/x.png")).toBe(
      "\x1b[200~/tmp/omp-ui-paste/x.png\x1b[201~",
    );
  });
});

describe("writeAdvisorOverlay", () => {
  it("pins both the enable flag and the model as strict-loadable YAML", () => {
    const dir = tmpDir();
    const file = writeAdvisorOverlay(
      dir,
      { model: "openrouter/anthropic/claude-opus-5", level: "high" },
      true,
    );
    expect(file).toBe(advisorOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      'advisor:\n  enabled: true\nmodelRoles:\n  advisor: "openrouter/anthropic/claude-opus-5:high"\n',
    );
  });

  it("writes enabled: false, the only way to turn the advisor off", () => {
    // Omitting `--advisor` does NOT disable it: the flag only ever sets
    // advisor.enabled=true, so a config saying true keeps it on. Verified
    // against omp v17.1.8 — without this line the composer's "off" is a no-op.
    const dir = tmpDir();
    const file = writeAdvisorOverlay(dir, null, false)!;
    expect(fs.readFileSync(file, "utf8")).toBe("advisor:\n  enabled: false\n");
  });

  it("omits modelRoles for a null role instead of pinning an empty one", () => {
    // An overlay setting the role to "" resolves to no advisor model at all,
    // which is not the same as deferring to omp's own config.
    const dir = tmpDir();
    const file = writeAdvisorOverlay(dir, null, true)!;
    expect(fs.readFileSync(file, "utf8")).toBe("advisor:\n  enabled: true\n");
  });

  it("removes the overlay when the session states no preference at all", () => {
    const dir = tmpDir();
    const file = writeAdvisorOverlay(dir, { model: "a/b" }, true)!;
    expect(writeAdvisorOverlay(dir, null, null)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is idempotent when there was never an overlay", () => {
    expect(writeAdvisorOverlay(tmpDir(), null, null)).toBeNull();
  });

  it("creates the lineage dir so --config cannot fail on a missing file", () => {
    // omp treats a missing `--config` overlay as a hard startup error.
    const dir = path.join(tmpDir(), "not-yet");
    const file = writeAdvisorOverlay(dir, { model: "a/b" }, true)!;
    expect(fs.existsSync(file)).toBe(true);
  });

  it("escapes a quote in the selector rather than emitting broken YAML", () => {
    const dir = tmpDir();
    const file = writeAdvisorOverlay(dir, { model: 'a/b"c' }, true)!;
    expect(fs.readFileSync(file, "utf8")).toBe(
      'advisor:\n  enabled: true\nmodelRoles:\n  advisor: "a/b\\"c"\n',
    );
  });
});
