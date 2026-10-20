import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDirPath, createChatDir, isInChatsRoot, removeChatDir, sweepOrphanChatDirs } from "./chat";

const UUID = "0b9f7c1e-3d4a-4e5f-8a6b-7c8d9e0f1a2b";

let base: string;
let root: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-chat-"));
  root = path.join(base, "chats");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("removeChatDir", () => {
  it.each([
    ["the root itself", () => root],
    ["a sibling-prefix path", () => path.join(`${root}-evil`, `chat-${UUID}`)],
    ["a nested path", () => path.join(root, `chat-${UUID}`, `chat-${UUID}`)],
    ["a wrong-shaped name", () => path.join(root, "notes")],
  ])("refuses %s and leaves it on disk", async (_label, target) => {
    const dir = target();
    fs.mkdirSync(dir, { recursive: true });
    await expect(removeChatDir(root, dir)).resolves.toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("removes a canonical chat dir", async () => {
    const dir = chatDirPath(root);
    createChatDir(root, dir);
    fs.writeFileSync(path.join(dir, "scratch.txt"), "x");
    await expect(removeChatDir(root, dir)).resolves.toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("sweepOrphanChatDirs", () => {
  it("removes only unreferenced canonical dirs", async () => {
    const kept = chatDirPath(root);
    const orphan = chatDirPath(root);
    createChatDir(root, kept);
    createChatDir(root, orphan);
    const foreign = path.join(root, "my-notes");
    fs.mkdirSync(foreign);

    const removed = await sweepOrphanChatDirs(root, (abs) => abs === kept);

    expect(removed).toEqual([orphan]);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("returns [] for a missing root", async () => {
    await expect(sweepOrphanChatDirs(root, () => false)).resolves.toEqual([]);
  });
});

describe("isInChatsRoot", () => {
  it("is true for the root and its descendants, false for a prefix sibling", () => {
    expect(isInChatsRoot(root, root)).toBe(true);
    expect(isInChatsRoot(root, path.join(root, `chat-${UUID}`, "sub"))).toBe(true);
    expect(isInChatsRoot(root, `${root}-evil`)).toBe(false);
  });
});
