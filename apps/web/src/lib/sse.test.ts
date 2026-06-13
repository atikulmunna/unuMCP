import { describe, expect, it } from "vitest";
import { parseSse } from "./sse";

interface Ev {
  type: string;
  chunk?: string;
}

describe("parseSse", () => {
  it("parses a single complete frame", () => {
    const { events, rest } = parseSse<Ev>('data: {"type":"log","chunk":"hi"}\n\n');
    expect(events).toEqual([{ type: "log", chunk: "hi" }]);
    expect(rest).toBe("");
  });

  it("parses multiple frames in one buffer", () => {
    const buf = 'data: {"type":"log","chunk":"a"}\n\ndata: {"type":"done"}\n\n';
    const { events } = parseSse<Ev>(buf);
    expect(events).toEqual([{ type: "log", chunk: "a" }, { type: "done" }]);
  });

  it("keeps an incomplete trailing frame in rest", () => {
    const { events, rest } = parseSse<Ev>('data: {"type":"log","chunk":"a"}\n\ndata: {"type":"do');
    expect(events).toEqual([{ type: "log", chunk: "a" }]);
    expect(rest).toBe('data: {"type":"do');
  });

  it("ignores comment/heartbeat frames and bad JSON", () => {
    const { events } = parseSse<Ev>(': keep-alive\n\ndata: not-json\n\ndata: {"type":"done"}\n\n');
    expect(events).toEqual([{ type: "done" }]);
  });
});
