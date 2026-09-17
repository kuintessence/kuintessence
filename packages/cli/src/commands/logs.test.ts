import { afterEach, describe, expect, test } from "bun:test";
import { follow } from "./logs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("logs follow", () => {
  test("passes the requested tail size and emits SSE log chunks", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchStub = (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        "event: log\ndata: epoch 1\ndata: epoch 2\ndata: \n\nevent: end\ndata: completed\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    fetchStub.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchStub;
    const chunks: string[] = [];

    await follow("http://server.example", "token-1", "job-1", (chunk) => chunks.push(chunk), 42);

    expect(requests).toEqual([
      {
        url: "http://server.example/api/jobs/job-1/logs/stream?lines=42",
        authorization: "Bearer token-1",
      },
    ]);
    expect(chunks).toEqual(["epoch 1\nepoch 2\n"]);
  });

  test("surfaces a server-side SSE error", async () => {
    const fetchStub = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      new Response("event: error\ndata: Agent is offline\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    fetchStub.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchStub;

    expect(follow("http://server.example", undefined, "job-1", () => undefined)).rejects.toThrow(
      "Agent is offline",
    );
  });

  test("gives a stable message when a terminal log file is unavailable", async () => {
    const fetchStub = (async (..._args: Parameters<typeof fetch>): Promise<Response> =>
      new Response(
        JSON.stringify({
          error: {
            code: "JOB_LOG_UNAVAILABLE",
            message: "Job logs are unavailable for this terminal job",
          },
        }),
        { status: 410, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    fetchStub.preconnect = originalFetch.preconnect;
    globalThis.fetch = fetchStub;

    await expect(
      follow("http://server.example", undefined, "job-1", () => undefined),
    ).rejects.toThrow("Job log output is not available yet or has been cleaned.");
  });
});
