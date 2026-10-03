import { describe, expect, it } from "vitest";
import {
  EVENT_FILTER_COMMAND_ID,
  eventFilterEchoIsDelta,
  setEventFilterCommand,
} from "./event-filter";

describe("setEventFilterCommand", () => {
  it("carries the fixed id, explicit null events, and delta mode", () => {
    expect(setEventFilterCommand()).toEqual({
      id: "omp-ui-event-filter-1",
      type: "set_event_filter",
      events: null,
      messageUpdates: "delta",
    });
  });

  it("accepts an id override without changing the payload", () => {
    expect(setEventFilterCommand("custom-2")).toMatchObject({
      id: "custom-2",
      type: "set_event_filter",
    });
  });

  it("keeps the fixed-id constant in step with the default payload", () => {
    expect(setEventFilterCommand()).toMatchObject({ id: EVENT_FILTER_COMMAND_ID });
  });
});

describe("eventFilterEchoIsDelta", () => {
  it("reads a delta echo as delta", () => {
    expect(eventFilterEchoIsDelta({ events: null, messageUpdates: "delta" })).toBe(true);
  });

  it("reads the documented full-mode default as not delta", () => {
    expect(eventFilterEchoIsDelta({ events: null, messageUpdates: "full" })).toBe(false);
  });

  it("reads junk as not delta", () => {
    for (const data of [undefined, null, "delta", 7, {}, { messageUpdates: null }]) {
      expect(eventFilterEchoIsDelta(data)).toBe(false);
    }
  });
});
