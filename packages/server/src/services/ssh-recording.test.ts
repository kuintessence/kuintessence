import { describe, expect, test } from "bun:test";
import {
  makeObjectStoreRecordingSink,
  recordingKeyFor,
  recordingStorageKey,
  type SshSessionRecording,
  toAsciinemaCast,
} from "./ssh-recording";

const rec: SshSessionRecording = {
  sessionId: "s1",
  agentId: "agent-1",
  user: "alice@x",
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_002_500,
  reason: "client closed",
  events: [
    { tMs: 500, data: new TextEncoder().encode("hello\n") },
    { tMs: 1500, data: new TextEncoder().encode("$ ") },
  ],
};

describe("ssh-recording", () => {
  test("toAsciinemaCast emits a v2 header then one output line per chunk", () => {
    const cast = toAsciinemaCast(rec, 120, 40);
    const lines = cast.trimEnd().split("\n");
    const header = JSON.parse(lines[0] ?? "");
    expect(header).toEqual({
      version: 2,
      width: 120,
      height: 40,
      timestamp: 1_700_000_000, // floor(startedAtMs/1000)
    });
    expect(JSON.parse(lines[1] ?? "")).toEqual([0.5, "o", "hello\n"]);
    expect(JSON.parse(lines[2] ?? "")).toEqual([1.5, "o", "$ "]);
    expect(cast.endsWith("\n")).toBe(true);
  });

  test("defaults to an 80x24 terminal", () => {
    const header = JSON.parse(toAsciinemaCast(rec).split("\n")[0] ?? "");
    expect(header.width).toBe(80);
    expect(header.height).toBe(24);
  });

  test("prefers the recording's captured cols/rows over the defaults", () => {
    const sized: SshSessionRecording = { ...rec, cols: 160, rows: 50 };
    const header = JSON.parse(toAsciinemaCast(sized).split("\n")[0] ?? "");
    // The session's negotiated geometry wins so the replay isn't clipped to 80x24.
    expect(header.width).toBe(160);
    expect(header.height).toBe(50);
  });

  test("storage key is namespaced by agent and session", () => {
    expect(recordingStorageKey(rec)).toBe("ssh-recordings/agent-1/s1.cast");
  });

  test("object-store sink uploads the cast under the recording key", async () => {
    const puts: Array<{ key: string; body: Uint8Array; contentType: string }> = [];
    const sink = makeObjectStoreRecordingSink({
      putBlob: async (key, body, contentType) => {
        puts.push({ key, body, contentType });
        return { etag: "e" };
      },
    });
    await sink(rec);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe("ssh-recordings/agent-1/s1.cast");
    expect(puts[0]?.contentType).toBe("application/x-asciicast");
    const text = new TextDecoder().decode(puts[0]?.body);
    expect(text).toBe(toAsciinemaCast(rec));
    expect(text).toContain('"o"'); // asciinema output event marker
    expect(text).toContain("hello");
  });

  test("object-store sink hands index metadata to onStored after upload", async () => {
    const stored: unknown[] = [];
    const sink = makeObjectStoreRecordingSink(
      { putBlob: async () => ({ etag: "e" }) },
      async (meta) => {
        stored.push(meta);
      },
    );
    await sink(rec);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      agentId: "agent-1",
      sessionId: "s1",
      user: "alice@x",
      storageKey: "ssh-recordings/agent-1/s1.cast",
      durationMs: 2500, // endedAtMs - startedAtMs
    });
    expect((stored[0] as { sizeBytes: number }).sizeBytes).toBeGreaterThan(0);
  });

  test("recordingKeyFor builds the expected key for valid ids", () => {
    expect(recordingKeyFor("agent-1", "550e8400-e29b-41d4-a716-446655440000")).toBe(
      "ssh-recordings/agent-1/550e8400-e29b-41d4-a716-446655440000.cast",
    );
  });

  test("recordingKeyFor rejects a path-traversal agentId", () => {
    expect(() => recordingKeyFor("../../etc/passwd", "s1")).toThrow(/invalid agentId/);
  });

  test("recordingKeyFor rejects a traversal/slash sessionId", () => {
    expect(() => recordingKeyFor("a", "../../secret")).toThrow(/invalid sessionId/);
    expect(() => recordingKeyFor("a", "b/c")).toThrow(/invalid sessionId/);
  });

  test("recordingKeyFor rejects a '..' segment even with otherwise-valid chars", () => {
    expect(() => recordingKeyFor("..", "s1")).toThrow(/invalid agentId/);
  });
});
