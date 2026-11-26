import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { nativeControl } from "../../lib/test-resource-field";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
  }),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: vi.fn() },
}));

const writes: string[] = [];
const terminalDisposals: ReturnType<typeof vi.fn>[] = [];
vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor() {
      terminalDisposals.push(this.dispose);
    }
    open = vi.fn();
    write = vi.fn((s: string) => writes.push(s));
    dispose = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { parseCast, SshRecordingPlayer } from "./SshRecordingPlayer";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writes.length = 0;
  terminalDisposals.length = 0;
});

describe("parseCast", () => {
  test("parses a v2 header + output events, ignoring non-output lines", () => {
    const cast = [
      JSON.stringify({ version: 2, width: 120, height: 40, timestamp: 1 }),
      JSON.stringify([0.5, "o", "hello"]),
      JSON.stringify([1, "i", "ls\n"]), // input — ignored
      JSON.stringify([1.5, "o", "$ "]),
      "",
    ].join("\n");
    const parsed = parseCast(cast);
    expect(parsed.width).toBe(120);
    expect(parsed.height).toBe(40);
    expect(parsed.events).toEqual([
      { tSec: 0.5, data: "hello" },
      { tSec: 1.5, data: "$ " },
    ]);
  });

  test("defaults dimensions when the header omits them", () => {
    const parsed = parseCast(JSON.stringify({ version: 2 }));
    expect(parsed.width).toBe(80);
    expect(parsed.height).toBe(24);
  });
});

const CAST = [
  JSON.stringify({ version: 2, width: 80, height: 24 }),
  JSON.stringify([0, "o", "welcome\n"]),
].join("\n");

/** Mock handling the list (GET /admin/ssh-recordings), presign (with ids),
 *  cast download, and DELETE. */
function recordingsFetch(opts: { recordings?: unknown[]; onDelete?: () => void }) {
  return vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    if (method === "DELETE") {
      opts.onDelete?.();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.endsWith("/admin/ssh-recordings")) {
      return new Response(JSON.stringify({ recordings: opts.recordings ?? [] }), { status: 200 });
    }
    if (url.includes("/admin/ssh-recordings/")) {
      return new Response(JSON.stringify({ url: "https://minio.local/rec.cast" }), { status: 200 });
    }
    return new Response(CAST, { status: 200 });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function controlledPlayback() {
  const downloads = { a: deferred<Response>(), b: deferred<Response>() };
  const deletion = deferred<Response>();
  const replay = deferred<Response>();
  let downloadingA = false;
  const fallback = recordingsFetch({
    recordings: Object.keys(downloads).map((sessionId) => ({
      agentId: "agent-1",
      sessionId,
      user: "alice",
      endedAt: "2026-06-04T00:01:00Z",
      durationMs: 1000,
      sizeBytes: 100,
    })),
  });
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") return deletion.promise;
    const session = url.endsWith("/a") ? "a" : "b";
    if (url.startsWith("https://recordings.local/")) {
      if (session === "a") {
        if (downloadingA) return replay.promise;
        downloadingA = true;
      }
      return downloads[session].promise;
    }
    if (url.includes("/admin/ssh-recordings/")) {
      return Promise.resolve(Response.json({ url: `https://recordings.local/${session}` }));
    }
    return fallback(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<SshRecordingPlayer />);
  await screen.findByTestId("ssh-rec-list-row-a");
  vi.useFakeTimers();
  const play = async (session: "a" | "b") => {
    await act(async () => fireEvent.click(screen.getByTestId(`ssh-rec-list-row-${session}`)));
  };
  return { ...view, downloads, deletion, fetchMock, play, replay };
}

function timedCast(output: string) {
  return new Response(
    `${JSON.stringify({ version: 2, width: 80, height: 24 })}\n${JSON.stringify([1, "o", output])}`,
  );
}

describe("SshRecordingPlayer", () => {
  test.each(["success", "failure"])("ignores a superseded download's late %s", async (result) => {
    const { downloads, play, fetchMock } = await controlledPlayback();
    await play("a");
    await play("b");
    await act(async () => downloads.b.resolve(timedCast("B")));
    await act(async () => {
      if (result === "success") downloads.a.resolve(timedCast("A"));
      else downloads.a.reject(new Error("late failure"));
    });
    act(() => vi.advanceTimersByTime(1000));

    expect(writes).toEqual(["B"]);
    expect(terminalDisposals).toHaveLength(1);
    expect(screen.queryByTestId("ssh-rec-error")).toBeNull();
    expect(screen.getByTestId("ssh-rec-delete")).toHaveProperty("disabled", false);
    const previousDownload = fetchMock.mock.calls.find(
      ([url]) => url === "https://recordings.local/a",
    );
    expect(previousDownload?.[1]?.signal?.aborted).toBe(true);
  });

  test("does not create a terminal or replay timers after unmount during body download", async () => {
    const { downloads, play, unmount } = await controlledPlayback();
    const body = deferred<string>();
    const response = timedCast("A");
    vi.spyOn(response, "text").mockReturnValue(body.promise);
    await play("a");
    await act(async () => downloads.a.resolve(response));
    unmount();
    await act(async () => body.resolve(await timedCast("A").text()));
    act(() => vi.advanceTimersByTime(1000));

    expect(terminalDisposals).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  test("clears scheduled output when switching recordings and on unmount", async () => {
    const { downloads, play, unmount } = await controlledPlayback();
    await play("a");
    await act(async () => downloads.a.resolve(timedCast("A")));
    await play("b");
    expect(screen.getByTestId("ssh-rec-delete")).toHaveProperty("disabled", true);
    act(() => vi.advanceTimersByTime(1000));
    expect(writes).toEqual([]);
    await act(async () => downloads.b.resolve(timedCast("B")));
    expect(terminalDisposals[0]).toHaveBeenCalledOnce();
    unmount();
    act(() => vi.advanceTimersByTime(1000));
    expect(writes).toEqual([]);
    expect(terminalDisposals[1]).toHaveBeenCalledOnce();
  });

  test("keeps a newer playback when an earlier recording deletion completes", async () => {
    const { downloads, deletion, play, fetchMock } = await controlledPlayback();
    await play("a");
    await act(async () => downloads.a.resolve(timedCast("A")));
    fireEvent.click(screen.getByTestId("ssh-rec-delete"));
    await play("b");
    await act(async () => downloads.b.resolve(timedCast("B")));
    await act(async () => deletion.resolve(Response.json({ ok: true })));
    act(() => vi.advanceTimersByTime(1000));

    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")?.[0]).toContain(
      "/admin/ssh-recordings/agent-1/a",
    );
    expect(writes).toEqual(["B"]);
    expect(terminalDisposals[1]).not.toHaveBeenCalled();
    expect(screen.getByTestId("ssh-rec-delete")).toHaveProperty("disabled", false);
  });

  test.each([
    "playback failure",
    "deletion",
  ])("clears a deleted terminal when %s completes first", async (first) => {
    const { downloads, deletion, play, fetchMock } = await controlledPlayback();
    await play("a");
    await act(async () => downloads.a.resolve(timedCast("A")));
    fireEvent.click(screen.getByTestId("ssh-rec-delete"));
    await play("b");

    const finishDeletion = () => act(async () => deletion.resolve(Response.json({ ok: true })));
    const failPlayback = () => act(async () => downloads.b.reject(new Error("download failed")));

    if (first === "playback failure") {
      await failPlayback();
      expect(screen.getByTestId("ssh-rec-error")).toBeTruthy();
      await finishDeletion();
    } else {
      await finishDeletion();
      expect(screen.getByTestId("ssh-rec-play")).toHaveProperty("disabled", true);
      await failPlayback();
    }

    expect(terminalDisposals[0]).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("ssh-rec-delete")).toBeNull();
    expect(screen.getByTestId("ssh-rec-error")).toBeTruthy();
    expect(screen.getByTestId("ssh-rec-play")).toHaveProperty("disabled", false);
    const activeDownload = fetchMock.mock.calls.find(
      ([url]) => url === "https://recordings.local/b",
    );
    expect(activeDownload?.[1]?.signal?.aborted).toBe(false);
  });

  test.each([
    "replay",
    "deletion",
  ])("clears a replay of the deleted recording when %s completes first", async (first) => {
    const { downloads, deletion, replay, play, fetchMock } = await controlledPlayback();
    await play("a");
    await act(async () => downloads.a.resolve(timedCast("A")));
    fireEvent.click(screen.getByTestId("ssh-rec-delete"));
    await play("a");

    if (first === "replay") {
      await act(async () => replay.resolve(timedCast("A again")));
      expect(terminalDisposals).toHaveLength(2);
    }
    await act(async () => deletion.resolve(Response.json({ ok: true })));

    const activeDownload = fetchMock.mock.calls
      .filter(([url]) => url === "https://recordings.local/a")
      .at(-1);
    expect(activeDownload?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByTestId("ssh-rec-delete")).toBeNull();
    expect(screen.getByTestId("ssh-rec-play")).toHaveProperty("disabled", false);
    if (first === "deletion") {
      await act(async () => replay.resolve(timedCast("A late")));
      expect(terminalDisposals).toHaveLength(1);
    }
    for (const dispose of terminalDisposals) expect(dispose).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1000));
    expect(writes).toEqual([]);
    expect(screen.queryByTestId("ssh-rec-delete")).toBeNull();
    expect(screen.queryByTestId("ssh-rec-error")).toBeNull();
  });

  test("shows a disabled state when recording is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ enabled: false, recordings: [] }), { status: 200 }),
      ),
    );
    render(<SshRecordingPlayer />);
    await waitFor(() => screen.getByTestId("ssh-rec-disabled"));
    expect(screen.queryByTestId("ssh-rec-play")).toBeNull();
    expect(screen.queryByTestId("ssh-rec-viewport")).toBeNull();
  });

  test("fetches a presigned URL, downloads the cast, and replays into xterm", async () => {
    vi.stubGlobal("fetch", recordingsFetch({}));
    render(<SshRecordingPlayer />);
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-agent")), {
      target: { value: "agent-1" },
    });
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-session")), {
      target: { value: "sess-1" },
    });
    fireEvent.click(screen.getByTestId("ssh-rec-play"));
    await waitFor(() => expect(writes.join("")).toContain("welcome"));
  });

  test("browses the recordings index and plays a row on click", async () => {
    vi.stubGlobal(
      "fetch",
      recordingsFetch({
        recordings: [
          {
            agentId: "agent-1",
            sessionId: "sess-9",
            user: "alice@x",
            startedAt: "2026-06-04T00:00:00Z",
            endedAt: "2026-06-04T00:01:00Z",
            durationMs: 60000,
            sizeBytes: 2048,
          },
        ],
      }),
    );
    render(<SshRecordingPlayer />);
    await waitFor(() => screen.getByTestId("ssh-rec-list-row-sess-9"));
    fireEvent.click(screen.getByTestId("ssh-rec-list-row-sess-9"));
    await waitFor(() => expect(writes.join("")).toContain("welcome"));
  });

  test("shows recording index errors while keeping manual playback and disabling delete", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const method = init?.method ?? "GET";
      if (method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/admin/ssh-recordings")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: "Authorization principal is not bound",
            },
          }),
          { status: 403 },
        );
      }
      if (url.includes("/admin/ssh-recordings/")) {
        return new Response(JSON.stringify({ url: "https://minio.local/rec.cast" }), {
          status: 200,
        });
      }
      return new Response(CAST, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SshRecordingPlayer />);

    expect((await screen.findByTestId("ssh-rec-list-error")).textContent).not.toContain(
      "Authorization principal is not bound",
    );
    expect(screen.queryByTestId("ssh-rec-list")).toBeNull();
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-agent")), {
      target: { value: "agent-1" },
    });
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-session")), {
      target: { value: "sess-1" },
    });
    fireEvent.click(screen.getByTestId("ssh-rec-play"));

    await waitFor(() => expect(writes.join("")).toContain("welcome"));
    expect(screen.getByTestId("ssh-rec-delete")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("ssh-rec-delete"));
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  test("deletes the loaded recording", async () => {
    let deleteCalled = false;
    vi.stubGlobal("fetch", recordingsFetch({ onDelete: () => (deleteCalled = true) }));
    render(<SshRecordingPlayer />);
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-agent")), {
      target: { value: "agent-1" },
    });
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-session")), {
      target: { value: "sess-1" },
    });
    fireEvent.click(screen.getByTestId("ssh-rec-play"));
    await waitFor(() => screen.getByTestId("ssh-rec-delete"));
    fireEvent.click(screen.getByTestId("ssh-rec-delete"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(deleteCalled).toBe(true);
  });

  test("surfaces a 404 (no recording) as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "No recording for that session" } }), {
            status: 404,
          }),
      ),
    );
    render(<SshRecordingPlayer />);
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-agent")), {
      target: { value: "a" },
    });
    fireEvent.change(nativeControl(screen.getByTestId("ssh-rec-session")), {
      target: { value: "s" },
    });
    fireEvent.click(screen.getByTestId("ssh-rec-play"));
    await waitFor(() => screen.getByTestId("ssh-rec-error"));
  });
});
