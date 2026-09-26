import { describe, expect, it } from "vitest";
import type { DesktopFrameDelivery } from "../browser-pane-desktop-protocol";
import { createDesktopPaneStream } from "./browser-pane-desktop-stream";

function harness() {
  const stream = createDesktopPaneStream();
  const sent: DesktopFrameDelivery[] = [];
  const send = (delivery: DesktopFrameDelivery): void => { sent.push(delivery); };
  const offer = (tabId: string, value: number): void => stream.offer(tabId, new Uint8Array([value]));
  return { stream, sent, send, offer };
}

describe("desktop pane stream", () => {
  it("waits for ready and bounds a stalled viewer to one flight plus latest per tab", () => {
    const h = harness();
    h.stream.subscribe("a", "desktop", true);
    h.offer("a", 0);
    expect(h.sent).toEqual([]);
    h.stream.ready(h.send);
    for (let n = 1; n <= 1000; n++) h.offer("a", n % 256);
    expect(h.sent.map((f) => f.frame[0])).toEqual([0]);
    h.stream.ack(h.sent[0]!.id);
    expect(h.sent.map((f) => f.frame[0])).toEqual([0, 1000 % 256]);
  });

  it("rejects foreign, duplicate and malformed ACKs without releasing credit", () => {
    const h = harness();
    h.stream.subscribe("a", "desktop", true);
    h.stream.ready(h.send);
    h.offer("a", 1);
    h.offer("a", 2);
    const first = h.sent[0]!.id;
    for (const bad of [0, first + 1, -1, NaN, Infinity, 1.5]) h.stream.ack(bad);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1]);
    h.stream.ack(first);
    h.offer("a", 3);
    h.stream.ack(first);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1, 2]);
    h.stream.ack(h.sent[1]!.id);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1, 2, 3]);
  });

  it("filters undesired tabs and drops last-unsubscribe pending without freeing inflight credit", () => {
    const h = harness();
    h.stream.subscribe("a", "one", true);
    h.stream.subscribe("a", "two", true);
    h.stream.subscribe("b", "one", true);
    h.stream.ready(h.send);
    h.offer("ignored", 9);
    h.offer("a", 1);
    h.offer("a", 2);
    h.stream.subscribe("a", "one", false);
    h.offer("a", 3);
    h.offer("b", 4);
    h.stream.subscribe("a", "two", false);
    h.offer("a", 5);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1]);
    h.stream.ack(h.sent[0]!.id);
    expect(h.sent.map((f) => [f.tabId, f.frame[0]])).toEqual([["a", 1], ["b", 4]]);
  });

  it("rotates pending tabs fairly without moving an updated tab to the back", () => {
    const h = harness();
    for (const tab of ["a", "b", "c"]) h.stream.subscribe(tab, tab, true);
    h.stream.ready(h.send);
    h.offer("a", 1);
    h.offer("b", 2);
    h.offer("c", 3);
    h.offer("b", 4);
    h.offer("a", 5);
    h.stream.ack(h.sent[0]!.id);
    h.offer("b", 6);
    h.stream.ack(h.sent[1]!.id);
    h.stream.ack(h.sent[2]!.id);
    h.stream.ack(h.sent[3]!.id);
    expect(h.sent.map((f) => [f.tabId, f.frame[0]])).toEqual([
      ["a", 1], ["b", 4], ["c", 3], ["a", 5], ["b", 6],
    ]);
  });

  it("switches one client's viewed tab without removing another client's subscription", () => {
    const h = harness();
    h.stream.subscribe("a", "one", true);
    h.stream.subscribe("a", "two", true);
    h.stream.subscribe("b", "one", true);
    h.stream.noteViewed("one", "b");
    expect(h.stream.reset()).toEqual([
      { tabId: "a", clientId: "two" }, { tabId: "b", clientId: "one" },
    ]);
    h.stream.subscribe("a", "one", true);
    h.offer("a", 1);
    h.stream.noteViewed("one", null);
    h.stream.ready(h.send);
    expect(h.sent).toEqual([]);
  });

  it("rebinds with latest pending, fences old ACKs and retains interrupted frames only without newer", () => {
    const h = harness();
    h.stream.subscribe("a", "one", true);
    h.stream.ready(h.send);
    h.offer("a", 1);
    h.offer("a", 2);
    const oldId = h.sent[0]!.id;
    h.stream.disconnect();
    h.offer("a", 3);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1]);
    h.stream.ready(h.send);
    h.offer("a", 4);
    h.stream.ack(oldId);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1, 3]);
    h.stream.ack(h.sent[1]!.id);
    h.stream.disconnect();
    h.stream.ready(h.send);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1, 3, 4, 4]);
    expect(h.sent.map((f) => f.id)).toEqual([1, 2, 3, 4]);
  });

  it("resets subscriptions and all queued frames but never resets delivery IDs", () => {
    const h = harness();
    h.stream.subscribe("a", "one", true);
    h.stream.ready(h.send);
    h.offer("a", 1);
    h.offer("a", 2);
    expect(h.stream.reset()).toEqual([{ tabId: "a", clientId: "one" }]);
    h.stream.ready(h.send);
    h.offer("a", 3);
    h.stream.subscribe("b", "two", true);
    h.offer("b", 4);
    h.offer("b", 5);
    h.stream.ack(h.sent[0]!.id);
    expect(h.sent.map((f) => [f.id, f.frame[0]])).toEqual([[1, 1], [2, 4]]);
    h.stream.ack(h.sent[1]!.id);
    expect(h.sent.map((f) => f.frame[0])).toEqual([1, 4, 5]);
  });

  it("disconnects a failed sender and delivers retained data on the next ready", () => {
    const h = harness();
    h.stream.subscribe("a", "one", true);
    h.stream.ready(() => { throw new Error("closed port"); });
    h.offer("a", 1);
    h.offer("a", 2);
    h.stream.ready(h.send);
    expect(h.sent.map((f) => [f.id, f.frame[0]])).toEqual([[2, 2]]);
  });
});
