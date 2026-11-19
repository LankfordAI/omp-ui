import { describe, expect, it } from "vitest";
import {
  ASK_DIALOG_COMMAND_ID,
  askDialogResponse,
  parseAskQuestions,
  setAskDialogCommand,
} from "./ask-dialog";

const QUESTIONS = parseAskQuestions([
  {
    id: "db",
    question: "Which database?",
    options: [{ label: "Postgres" }, { label: "SQLite" }],
    recommended: 1,
  },
  {
    id: "features",
    question: "Which features?",
    options: ["Auth", "Billing"],
    multi: true,
  },
]);

describe("setAskDialogCommand (issue #1234)", () => {
  it("builds the opt-in command on the fixed id", () => {
    expect(setAskDialogCommand()).toEqual({
      id: ASK_DIALOG_COMMAND_ID,
      type: "set_ask_dialog",
      enabled: true,
    });
  });

  it("takes a custom id like every boot-rail command", () => {
    expect(setAskDialogCommand("x-1")).toMatchObject({ id: "x-1" });
  });
});

describe("parseAskQuestions", () => {
  it("reads the probed wire shape with recommended and multi", () => {
    expect(QUESTIONS).toEqual([
      {
        id: "db",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        multi: false,
        recommended: 1,
      },
      {
        id: "features",
        question: "Which features?",
        options: [{ label: "Auth" }, { label: "Billing" }],
        multi: true,
      },
    ]);
  });

  it("keeps header, description, and preview when the frame carries them", () => {
    const [only] = parseAskQuestions([
      {
        id: "a",
        question: "Q?",
        header: "Setup",
        options: [{ label: "X", description: "d", preview: "p" }],
      },
    ]);
    expect(only).toEqual({
      id: "a",
      question: "Q?",
      header: "Setup",
      options: [{ label: "X", description: "d", preview: "p" }],
      multi: false,
    });
  });

  it("drops malformed entries and reads a missing list as empty", () => {
    expect(parseAskQuestions(undefined)).toEqual([]);
    expect(parseAskQuestions(["x", { question: "no id" }, { id: "" }])).toEqual([]);
    const [kept] = parseAskQuestions([{ id: "a", question: "Q?" }]);
    expect(kept?.options).toEqual([]);
  });

  it("ignores a non-integer or negative recommended index", () => {
    const [q] = parseAskQuestions([
      { id: "a", question: "Q?", options: ["X"], recommended: -1 },
    ]);
    expect(q?.recommended).toBeUndefined();
  });
});

describe("askDialogResponse", () => {
  it("lists one entry per question, in order, echoing ids", () => {
    const answers = {
      db: { selectedOptions: [], customInput: "DuckDB" },
      features: { selectedOptions: ["Auth"] },
    };
    expect(askDialogResponse(QUESTIONS, answers).answers).toEqual([
      { id: "db", selectedOptions: [], customInput: "DuckDB" },
      { id: "features", selectedOptions: ["Auth"] },
    ]);
  });

  it("sends an untouched question as an empty entry — never an invented default", () => {
    const answers = { db: { selectedOptions: ["Postgres"] } };
    expect(askDialogResponse(QUESTIONS, answers).answers).toEqual([
      { id: "db", selectedOptions: ["Postgres"] },
      { id: "features", selectedOptions: [] },
    ]);
  });

  it("keeps an answered multi-select empty on purpose", () => {
    const answers = { db: { selectedOptions: [], customInput: "" }, features: { selectedOptions: [] } };
    expect(askDialogResponse(QUESTIONS, answers).answers[1]).toEqual({
      id: "features",
      selectedOptions: [],
    });
  });

  it("trims free text and drops it when blank", () => {
    const trimmed = { db: { selectedOptions: [], customInput: "  DuckDB  " } };
    expect(askDialogResponse(QUESTIONS, trimmed).answers[0]).toEqual({
      id: "db",
      selectedOptions: [],
      customInput: "DuckDB",
    });
    const blank = { db: { selectedOptions: ["Postgres"], customInput: "   " } };
    expect(askDialogResponse(QUESTIONS, blank).answers[0]).toEqual({
      id: "db",
      selectedOptions: ["Postgres"],
    });
  });
});
