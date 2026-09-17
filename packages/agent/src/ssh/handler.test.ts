import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import pino from "pino";
import type { Ssh2ClientLike, Ssh2Factory } from "./client";
import { SshHandler, type SshOutgoingMessage } from "./handler";

const silent = pino({ level: "silent" });

// Minimal fake — same shape as in client.test.ts but stripped to the bits the
// handler-level lifecycle test cares about.
function fakeFactory() {
  const handlers = {
    ready: [] as Array<() => void>,
    error: [] as Array<(err: Error) => void>,
    end: [] as Array<() => void>,
    close: [] as Array<() => void>,
  };
  const channelHandlers = {
    data: [] as Array<(c: Buffer) => void>,
    close: [] as Array<() => void>,
  };
  const writes: Buffer[] = [];
  const setWindowCalls: Array<[number, number, number, number]> = [];
  let ended = false;
  type FakeClient = Ssh2ClientLike & {
    driver: {
      fireReady: () => void;
      emitData: (chunk: Buffer) => void;
      emitClose: () => void;
      writes: Buffer[];
      setWindowCalls: Array<[number, number, number, number]>;
      ended: () => boolean;
    };
  };
  const fake = {
    driver: {
      fireReady: () => {
        for (const cb of handlers.ready) cb();
      },
      emitData: (c: Buffer) => {
        for (const cb of channelHandlers.data) cb(c);
      },
      emitClose: () => {
        for (const cb of channelHandlers.close) cb();
      },
      writes,
      setWindowCalls,
      ended: () => ended,
    },
    on: (event: string, cb: (...a: unknown[]) => void) => {
      if (event === "ready") handlers.ready.push(cb as () => void);
      else if (event === "error") handlers.error.push(cb as (e: Error) => void);
      else if (event === "end") handlers.end.push(cb as () => void);
      else if (event === "close") handlers.close.push(cb as () => void);
      return fake;
    },
    shell: (cb: (err: Error | undefined, stream: unknown) => void) => {
      const stream = {
        on: (event: string, cb2: (...a: unknown[]) => void) => {
          if (event === "data") channelHandlers.data.push(cb2 as (c: Buffer) => void);
          else if (event === "close") channelHandlers.close.push(cb2 as () => void);
          return stream;
        },
        stderr: { on: () => stream.stderr },
        write: (b: Buffer) => writes.push(b),
        setWindow: (rows: number, cols: number, height: number, width: number) =>
          setWindowCalls.push([rows, cols, height, width]),
        end: () => {
          ended = true;
        },
      };
      cb(undefined, stream);
      return true;
    },
    connect: () => fake,
    end: () => {
      ended = true;
      return fake;
    },
  } as unknown as FakeClient;
  const factory: Ssh2Factory = () => fake;
  return { factory, fake };
}

describe("SshHandler", () => {
  test("Open → Data → Close lifecycle drives the underlying client", () => {
    const { factory, fake } = fakeFactory();
    const out: SshOutgoingMessage[] = [];
    const handler = new SshHandler({
      ssh2Factory: factory,
      enqueue: (m) => out.push(m),
      logger: silent,
    });

    handler.handleOpen({
      sessionId: "s1",
      host: "h",
      port: 22,
      username: "u",
      password: "p",
    });
    fake.driver.fireReady();

    // Output coming from the channel goes back via enqueue
    fake.driver.emitData(Buffer.from("welcome"));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("sshOutput");
    expect(out[0]?.sessionId).toBe("s1");
    expect(out[0]?.data?.toString()).toBe("welcome");

    // Stdin from the Server is forwarded
    handler.handleData("s1", Buffer.from("ls\n"));
    expect(fake.driver.writes.map((b) => b.toString())).toEqual(["ls\n"]);

    // Server-initiated close emits an sshClosed
    handler.handleClose("s1", "user closed");
    const closed = out.find((m) => m.kind === "sshClosed");
    expect(closed?.reason).toBe("user closed");
    expect(handler.activeCount()).toBe(0);
  });

  test("handleResize forwards cols/rows to the channel as setWindow(rows, cols, 0, 0)", () => {
    const { factory, fake } = fakeFactory();
    const handler = new SshHandler({ ssh2Factory: factory, enqueue: () => {}, logger: silent });
    handler.handleOpen({ sessionId: "s1", host: "h", port: 22, username: "u", password: "p" });
    fake.driver.fireReady();
    handler.handleResize("s1", 120, 40);
    expect(fake.driver.setWindowCalls).toEqual([[40, 120, 0, 0]]);
  });

  test("missing auth payload synthesizes an immediate sshClosed", () => {
    const { factory } = fakeFactory();
    const out: SshOutgoingMessage[] = [];
    const handler = new SshHandler({
      ssh2Factory: factory,
      enqueue: (m) => out.push(m),
      logger: silent,
    });

    handler.handleOpen({
      sessionId: "s1",
      host: "h",
      port: 22,
      username: "u",
    });

    expect(out).toEqual([{ kind: "sshClosed", sessionId: "s1", reason: "auth payload missing" }]);
  });

  test("empty sessionId is rejected on every entrypoint", () => {
    const { factory } = fakeFactory();
    const out: SshOutgoingMessage[] = [];
    const handler = new SshHandler({
      ssh2Factory: factory,
      enqueue: (m) => out.push(m),
      logger: silent,
    });

    handler.handleOpen({ sessionId: "", host: "h", port: 22, username: "u", password: "p" });
    handler.handleData("", Buffer.from("x"));
    handler.handleClose("", "");

    expect(out).toEqual([]);
    expect(handler.activeCount()).toBe(0);
  });

  test("remote channel close emits sshClosed with reason='channel closed'", () => {
    const { factory, fake } = fakeFactory();
    const out: SshOutgoingMessage[] = [];
    const handler = new SshHandler({
      ssh2Factory: factory,
      enqueue: (m) => out.push(m),
      logger: silent,
    });

    handler.handleOpen({
      sessionId: "s1",
      host: "h",
      port: 22,
      username: "u",
      password: "p",
    });
    fake.driver.fireReady();
    fake.driver.emitClose();

    const closed = out.find((m) => m.kind === "sshClosed");
    expect(closed?.reason).toBe("channel closed");
    expect(handler.activeCount()).toBe(0);
  });

  test("shutdown closes every active session", () => {
    const { factory } = fakeFactory();
    const out: SshOutgoingMessage[] = [];
    const handler = new SshHandler({
      ssh2Factory: factory,
      enqueue: (m) => out.push(m),
      logger: silent,
    });

    handler.handleOpen({
      sessionId: "s1",
      host: "h",
      port: 22,
      username: "u",
      password: "p",
    });
    handler.shutdown("agent shutdown");

    const closed = out.filter((m) => m.kind === "sshClosed");
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed.some((c) => c.reason === "agent shutdown")).toBe(true);
  });
});
