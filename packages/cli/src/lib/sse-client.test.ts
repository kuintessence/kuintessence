// SSE client unit tests.
import { describe, expect, it } from "bun:test";
import { parseEvent, SseClient } from "./sse-client";

describe("parseEvent", () => {
  it("parses a single-data event", () => {
    expect(parseEvent("event: log\ndata: hello world")).toEqual({
      event: "log",
      data: "hello world",
      id: undefined,
    });
  });
  it("joins multi-line data", () => {
    expect(parseEvent("event: log\ndata: line1\ndata: line2")).toEqual({
      event: "log",
      data: "line1\nline2",
      id: undefined,
    });
  });
  it("defaults to event:message", () => {
    expect(parseEvent("data: hi")?.event).toBe("message");
  });
  it("returns null for blocks without data", () => {
    expect(parseEvent("event: ping")).toBe(null);
  });
  it("captures id field", () => {
    expect(parseEvent("event: log\ndata: x\nid: 42")?.id).toBe("42");
  });
});

describe("SseClient.events", () => {
  function streamFromString(s: string) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(s));
        controller.close();
      },
    });
  }

  it("yields parsed events from a single fetch response", async () => {
    const fakeFetch = async () =>
      new Response(
        streamFromString("event: log\ndata: a\n\nevent: log\ndata: b\n\nevent: end\ndata: ok\n\n"),
        { status: 200 },
      );
    const sse = new SseClient("http://x", undefined, { fetch: fakeFetch });
    const events = [];
    for await (const ev of sse.events()) events.push(ev);
    expect(events.map((e) => e.data)).toEqual(["a", "b", "ok"]);
  });

  it("throws ApiError on non-2xx response", async () => {
    const fakeFetch = async () => new Response("nope", { status: 404 });
    const sse = new SseClient("http://x", undefined, { fetch: fakeFetch });
    await expect(async () => {
      for await (const _ of sse.events()) {
        // unreachable
      }
    }).toThrow();
  });

  it("preserves a Server error envelope on non-2xx response", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "JOB_LOG_UNAVAILABLE",
            message: "Job logs are unavailable for this terminal job",
          },
        }),
        { status: 410, headers: { "content-type": "application/json" } },
      );
    const sse = new SseClient("http://x", undefined, { fetch: fakeFetch });

    const readEvents = async () => {
      for await (const _ of sse.events()) {
        // unreachable
      }
    };
    await expect(readEvents()).rejects.toMatchObject({ code: "JOB_LOG_UNAVAILABLE", status: 410 });
  });
});
