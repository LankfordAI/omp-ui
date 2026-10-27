// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSideQuestionTitles,
  rememberSideQuestionTitle,
  SIDE_QUESTION_TITLE_LIMIT,
} from "./side-question-titles";

const KEY = "omp-ui.sideQuestionTitles";

describe("side question titles", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a remembered title through storage", () => {
    expect(rememberSideQuestionTitle("rec-1", "/sitrep foo")).toEqual({ "rec-1": "/sitrep foo" });
    rememberSideQuestionTitle("2", "/sitrep");
    expect(loadSideQuestionTitles()).toEqual({ "rec-1": "/sitrep foo", "2": "/sitrep" });
  });

  it("remembering the 501st id drops the oldest", () => {
    for (let i = 0; i < SIDE_QUESTION_TITLE_LIMIT; i++) rememberSideQuestionTitle(`id-${i}`, `/t ${i}`);
    const titles = rememberSideQuestionTitle("id-new", "/t new");
    expect(Object.keys(titles)).toHaveLength(SIDE_QUESTION_TITLE_LIMIT);
    expect(titles["id-0"]).toBeUndefined();
    expect(titles["id-1"]).toBe("/t 1");
    expect(titles["id-new"]).toBe("/t new");
    expect(loadSideQuestionTitles()).toEqual(titles);
  });

  it("re-remembering an id moves it to newest so it survives the next prune", () => {
    for (let i = 0; i < SIDE_QUESTION_TITLE_LIMIT; i++) rememberSideQuestionTitle(`id-${i}`, `/t ${i}`);
    rememberSideQuestionTitle("id-0", "/t again");
    const titles = rememberSideQuestionTitle("id-new", "/t new");
    expect(Object.keys(titles)).toHaveLength(SIDE_QUESTION_TITLE_LIMIT);
    expect(titles["id-0"]).toBe("/t again");
    expect(titles["id-1"]).toBeUndefined();
  });

  it("corrupt storage loads as empty", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(loadSideQuestionTitles()).toEqual({});
    window.localStorage.setItem(KEY, JSON.stringify({ a: "b" }));
    expect(loadSideQuestionTitles()).toEqual({});
    window.localStorage.setItem(KEY, JSON.stringify([["a", "b"], ["c", 3]]));
    expect(loadSideQuestionTitles()).toEqual({});
  });
});
