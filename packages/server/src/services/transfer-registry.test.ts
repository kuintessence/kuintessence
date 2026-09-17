import { describe, expect, it } from "bun:test";
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
});
