import { describe, expect, it } from "vitest";
import { LogBus, type SandboxLogEvent } from "../src/testing/log-bus";

describe("LogBus (P4-8)", () => {
  it("delivers published events to a subscriber in order", () => {
    const bus = new LogBus();
    const got: SandboxLogEvent[] = [];
    const sub = bus.subscribe("p1").subscribe((e) => got.push(e));

    bus.publish("p1", { type: "status", status: "running" });
    bus.publish("p1", { type: "log", phase: "test", chunk: "hello" });
    bus.publish("p1", { type: "done" });
    sub.unsubscribe();

    expect(got).toEqual([
      { type: "status", status: "running" },
      { type: "log", phase: "test", chunk: "hello" },
      { type: "done" },
    ]);
  });

  it("isolates events by projectId", () => {
    const bus = new LogBus();
    const a: SandboxLogEvent[] = [];
    const b: SandboxLogEvent[] = [];
    const subA = bus.subscribe("a").subscribe((e) => a.push(e));
    const subB = bus.subscribe("b").subscribe((e) => b.push(e));

    bus.publish("a", { type: "log", chunk: "for-a" });
    subA.unsubscribe();
    subB.unsubscribe();

    expect(a).toEqual([{ type: "log", chunk: "for-a" }]);
    expect(b).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new LogBus();
    const got: SandboxLogEvent[] = [];
    const sub = bus.subscribe("p1").subscribe((e) => got.push(e));
    bus.publish("p1", { type: "log", chunk: "1" });
    sub.unsubscribe();
    bus.publish("p1", { type: "log", chunk: "2" });
    expect(got).toEqual([{ type: "log", chunk: "1" }]);
  });

  it("fans out to multiple subscribers", () => {
    const bus = new LogBus();
    const one: SandboxLogEvent[] = [];
    const two: SandboxLogEvent[] = [];
    const s1 = bus.subscribe("p1").subscribe((e) => one.push(e));
    const s2 = bus.subscribe("p1").subscribe((e) => two.push(e));
    bus.publish("p1", { type: "done" });
    s1.unsubscribe();
    s2.unsubscribe();
    expect(one).toEqual([{ type: "done" }]);
    expect(two).toEqual([{ type: "done" }]);
  });
});
