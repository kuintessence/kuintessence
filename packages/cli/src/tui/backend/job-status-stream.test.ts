import { describe, expect, test } from "bun:test";
import { ApiClient } from "../../lib/api-client";
import {
  buildJobWsUrl,
  buildWorkflowWsUrl,
  type JobWsLike,
  subscribeJobStatus,
  subscribeWorkflowEvents,
} from "./job-status-stream";
import { RemoteBackend } from "./remote";

/** Fake WS capturing the message handler so tests can drive frames. */
function fakeWs(): {
  ws: JobWsLike;
  emit: (data: unknown) => void;
  closed: () => boolean;
} {
  let messageCb: ((ev: { data: unknown }) => void) | undefined;
  let isClosed = false;
  const ws: JobWsLike = {
    addEventListener(type, cb) {
      if (type === "message") messageCb = cb as (ev: { data: unknown }) => void;
    },
    close() {
      isClosed = true;
    },
  };
  return {
    ws,
    emit: (data) => messageCb?.({ data }),
    closed: () => isClosed,
  };
}

describe("buildJobWsUrl", () => {
  test("maps http→ws and https→wss, appends token", () => {
    expect(buildJobWsUrl("http://server:3000", "j1", "tok")).toBe(
      "ws://server:3000/ws/jobs/j1?token=tok",
    );
    expect(buildJobWsUrl("https://server.example/", "j2")).toBe("wss://server.example/ws/jobs/j2");
  });
});

describe("subscribeJobStatus", () => {
  test("invokes onStatus for job.status frames and ignores others", () => {
    const seen: string[] = [];
    const f = fakeWs();
    subscribeJobStatus({
      url: "ws://x/ws/jobs/j1",
      wsFactory: () => f.ws,
      onStatus: (s) => seen.push(s),
    });
    f.emit(JSON.stringify({ type: "job.status", status: "running" }));
    f.emit(JSON.stringify({ type: "other", status: "ignored" }));
    f.emit("not json");
    f.emit(JSON.stringify({ type: "job.status", status: "completed" }));
    expect(seen).toEqual(["running", "completed"]);
  });

  test("unsubscribe closes the socket and suppresses later frames", () => {
    const seen: string[] = [];
    const f = fakeWs();
    const unsub = subscribeJobStatus({
      url: "ws://x/ws/jobs/j1",
      wsFactory: () => f.ws,
      onStatus: (s) => seen.push(s),
    });
    unsub();
    expect(f.closed()).toBe(true);
    f.emit(JSON.stringify({ type: "job.status", status: "running" }));
    expect(seen).toEqual([]);
  });

  test("a throwing factory degrades to a no-op (returns a safe unsubscribe)", () => {
    const unsub = subscribeJobStatus({
      url: "ws://x",
      wsFactory: () => {
        throw new Error("offline");
      },
      onStatus: () => {},
    });
    expect(() => unsub()).not.toThrow();
  });
});

describe("buildWorkflowWsUrl", () => {
  test("maps to the workflows ws path", () => {
    expect(buildWorkflowWsUrl("http://server:3000", "r1", "tok")).toBe(
      "ws://server:3000/ws/workflows/r1?token=tok",
    );
  });
});

describe("subscribeWorkflowEvents", () => {
  test("fires onStep for workflow.step frames only", () => {
    let steps = 0;
    const f = fakeWs();
    subscribeWorkflowEvents({
      url: "ws://x/ws/workflows/r1",
      wsFactory: () => f.ws,
      onStep: () => {
        steps += 1;
      },
    });
    f.emit(JSON.stringify({ type: "workflow.step", stepId: "build", status: "running" }));
    f.emit(JSON.stringify({ type: "job.status", status: "running" }));
    f.emit(JSON.stringify({ type: "workflow.step", stepId: "build", status: "completed" }));
    expect(steps).toBe(2);
  });
});

describe("RemoteBackend.subscribeJobStatus", () => {
  test("maps Server status frames through toTuiStatus", () => {
    const f = fakeWs();
    const backend = new RemoteBackend(
      new ApiClient("http://server.test", "tok"),
      { serverUrl: "http://server.test", token: "tok" },
      () => f.ws,
    );
    const seen: string[] = [];
    backend.subscribeJobStatus("j1", (s) => seen.push(s));
    f.emit(JSON.stringify({ type: "job.status", status: "RUNNING" }));
    f.emit(JSON.stringify({ type: "job.status", status: "succeeded" }));
    expect(seen).toEqual(["running", "completed"]);
  });
});
