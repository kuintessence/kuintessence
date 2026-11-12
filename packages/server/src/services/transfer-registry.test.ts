import { describe, expect, it, spyOn } from "bun:test";
import { type TransferProgressEvent, TransferRegistry } from "./transfer-registry";

describe("TransferRegistry", () => {
  it("delivers a succeeded event with multipart part ETags to the listener", () => {
    const registry = new TransferRegistry();
    const received: TransferProgressEvent[] = [];
    registry.register("t1", (e) => received.push(e), 10_000);

    const delivered = registry.update("t1", {
      copiedBytes: 10,
      state: "succeeded",
      parts: [{ partNumber: 1, etag: "e1" }],
    });

    expect(delivered).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.parts).toEqual([{ partNumber: 1, etag: "e1" }]);
  });
  it("clears replaced timers and ignores an already queued old timeout", () => {
    const callbacks: (() => void)[] = [];
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as unknown as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const registry = new TransferRegistry();
      const oldEvents: TransferProgressEvent[] = [];
      const newEvents: TransferProgressEvent[] = [];
      registry.register("retry", (event) => oldEvents.push(event), 10);
      registry.register("retry", (event) => newEvents.push(event), 100);
      expect(clear).toHaveBeenCalledWith(1);
      callbacks[0]?.();
      expect(oldEvents).toEqual([]);
      expect(newEvents).toEqual([]);
      expect(registry.update("retry", { copiedBytes: 1, state: "running" })).toBe(true);
      callbacks[1]?.();
      expect(newEvents.map((event) => event.state)).toEqual(["running", "failed"]);
      expect(registry.update("retry", { copiedBytes: 1, state: "running" })).toBe(false);
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  });
  it("preserves a new registration created by a terminal listener", () => {
    const registry = new TransferRegistry();
    const received: TransferProgressEvent[] = [];
    registry.register(
      "retry",
      () => registry.register("retry", (event) => received.push(event), 10000),
      10000,
    );
    registry.update("retry", { copiedBytes: 0, state: "failed" });
    expect(registry.update("retry", { copiedBytes: 1, state: "succeeded" })).toBe(true);
    expect(received).toHaveLength(1);
  });
});
