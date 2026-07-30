import { describe, expect, it } from "vitest";
import { RpcChunkReassembler } from "./codec";

function harness(maxReassembledBytes?: number) {
  const frames: unknown[] = [];
  const errors: string[] = [];
  const r = new RpcChunkReassembler(
    (f) => frames.push(f),
    (m) => errors.push(m),
    maxReassembledBytes,
  );
  return { r, frames, errors };
}

function chunksOf(frame: unknown, count: number, chunkId = "c1"): string[] {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const size = Math.ceil(bytes.length / count);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * size, Math.min((i + 1) * size, bytes.length));
    lines.push(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId,
        index: i,
        count,
        byteLength: bytes.length,
        data: part.toString("base64"),
      }),
    );
  }
  return lines;
}

describe("RpcChunkReassembler", () => {
  it("passes plain frames through", () => {
    const { r, frames, errors } = harness();
    r.pushLine('{"type":"ready","protocolVersion":1}');
    expect(frames).toEqual([{ type: "ready", protocolVersion: 1 }]);
    expect(errors).toEqual([]);
  });

  it("surfaces an OMP overflow frame as a normal frame", () => {
    const { r, frames } = harness();
    r.pushLine('{"type":"rpc_overflow","byteLength":70000000}');
    expect(frames).toEqual([{ type: "rpc_overflow", byteLength: 70000000 }]);
  });

  it("reports invalid JSON as a protocol error", () => {
    const { r, errors } = harness();
    r.pushLine("{not json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/invalid JSON frame/);
  });

  it("reassembles a chunked frame", () => {
    const { r, frames, errors } = harness();
    const big = { type: "message_update", text: "x".repeat(500) };
    for (const line of chunksOf(big, 3)) r.pushLine(line);
    expect(errors).toEqual([]);
    expect(frames).toEqual([big]);
  });

  it("reassembles independent streams sequentially", () => {
    const { r, frames, errors } = harness();
    for (const line of chunksOf({ n: 1 }, 2, "a")) r.pushLine(line);
    for (const line of chunksOf({ n: 2 }, 2, "b")) r.pushLine(line);
    expect(errors).toEqual([]);
    expect(frames).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("rejects a stream that does not start at index 0", () => {
    const { r, errors } = harness();
    r.pushLine(
      '{"type":"rpc_chunk","chunkId":"c","index":1,"count":2,"byteLength":10,"data":"eA=="}',
    );
    expect(errors[0]).toMatch(/starts at index 1/);
  });

  it("rejects a chunkId change mid-stream", () => {
    const { r, frames, errors } = harness();
    const lines = chunksOf({ big: "y".repeat(100) }, 2);
    r.pushLine(lines[0]!);
    r.pushLine(lines[1]!.replace('"c1"', '"other"'));
    expect(errors[0]).toMatch(/chunkId changed/);
    expect(frames).toEqual([]);
  });

  it("rejects inconsistent count/byteLength across chunks", () => {
    const { r, errors } = harness();
    const lines = chunksOf({ big: "y".repeat(100) }, 2);
    r.pushLine(lines[0]!);
    r.pushLine(lines[1]!.replace('"count":2', '"count":3'));
    expect(errors[0]).toMatch(/inconsistent/);
  });

  it("rejects an out-of-order index", () => {
    const { r, errors } = harness();
    const lines = chunksOf({ big: "y".repeat(100) }, 3);
    r.pushLine(lines[0]!);
    r.pushLine(lines[2]!);
    expect(errors[0]).toMatch(/index 2, expected 1/);
  });

  it("rejects reassembly over the cap", () => {
    const { r, errors } = harness(16);
    const lines = chunksOf({ big: "y".repeat(100) }, 2);
    r.pushLine(lines[0]!);
    r.pushLine(lines[1]!);
    expect(errors[0]).toMatch(/cap/);
  });

  it("rejects a reassembled payload that is not JSON", () => {
    const { r, frames, errors } = harness();
    const bytes = Buffer.from("not json at all", "utf8");
    r.pushLine(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId: "c",
        index: 0,
        count: 1,
        byteLength: bytes.length,
        data: bytes.toString("base64"),
      }),
    );
    expect(errors[0]).toMatch(/not valid JSON/);
    expect(frames).toEqual([]);
  });

  it("rejects malformed chunk fields", () => {
    const { r, errors } = harness();
    r.pushLine('{"type":"rpc_chunk","chunkId":"c","index":0}');
    expect(errors[0]).toMatch(/malformed rpc_chunk/);
  });

  it("recovers after a rejected stream (next stream reassembles)", () => {
    const { r, frames, errors } = harness();
    r.pushLine(lines0withWrongIndex());
    const ok = { type: "response", success: true, payload: "z".repeat(50) };
    for (const line of chunksOf(ok, 2, "c2")) r.pushLine(line);
    expect(errors).toHaveLength(1);
    expect(frames).toEqual([ok]);
  });
});

function lines0withWrongIndex(): string {
  return '{"type":"rpc_chunk","chunkId":"bad","index":5,"count":6,"byteLength":99,"data":"eA=="}';
}
