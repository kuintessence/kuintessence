import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

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
vi.mock("@xterm/xterm", () => {
  class Terminal {
    open = vi.fn();
    write = vi.fn((s: string) => writes.push(s));
    dispose = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { parseCast, SshRecordingPlayer } from "./SshRecordingPlayer";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  writes.length = 0;
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

describe("SshRecordingPlayer", () => {
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
    fireEvent.change(screen.getByTestId("ssh-rec-agent"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("ssh-rec-session"), { target: { value: "sess-1" } });
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
    fireEvent.change(screen.getByTestId("ssh-rec-agent"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("ssh-rec-session"), { target: { value: "sess-1" } });
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
    fireEvent.change(screen.getByTestId("ssh-rec-agent"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("ssh-rec-session"), { target: { value: "sess-1" } });
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
    fireEvent.change(screen.getByTestId("ssh-rec-agent"), { target: { value: "a" } });
    fireEvent.change(screen.getByTestId("ssh-rec-session"), { target: { value: "s" } });
    fireEvent.click(screen.getByTestId("ssh-rec-play"));
    await waitFor(() => screen.getByTestId("ssh-rec-error"));
  });
});
