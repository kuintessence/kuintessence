import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import pino from "pino";
import type { Ssh2ClientLike, Ssh2Factory } from "./client";
import { hostKeySha256, SshClient } from "./client";

const silent = pino({ level: "silent" });

// -----------------------------------------------------------------------------
// Fake ssh2.Client used in every test below. Captures every event listener
// the production code attaches and exposes a tiny driver API to simulate the
// real ssh2 lifecycle (ready -> shell -> data -> close).
// -----------------------------------------------------------------------------

interface FakeChannel {
  writes: Buffer[];
  ended: boolean;
  /** Captured setWindow(rows, cols, height, width) calls. */
  setWindowCalls: Array<[number, number, number, number]>;
  emitData: (chunk: Buffer) => void;
  emitClose: () => void;
  emitError: (err: Error) => void;
}

interface FakeClient extends Ssh2ClientLike {
  driver: {
    fireReady: () => void;
    fireError: (err: Error) => void;
    fireEnd: () => void;
    fireClose: () => void;
    /** When set, shell(cb) calls cb synchronously with the channel. */
    autoShell: boolean;
    /** When set, shell(cb) calls cb with this error (no channel). */
    shellError?: Error;
    /** Returned by `client.shell()` — false simulates ssh2's backpressure refusal. */
    shellReturn: boolean;
    channel: FakeChannel | null;
    connectCalls: Array<Record<string, unknown>>;
    ended: boolean;
  };
}

function makeFakeClient(): FakeClient {
  const handlers: {
    ready: Array<() => void>;
    error: Array<(err: Error) => void>;
    end: Array<() => void>;
    close: Array<() => void>;
  } = { ready: [], error: [], end: [], close: [] };
  const channelHandlers: {
    data: Array<(chunk: Buffer) => void>;
    close: Array<() => void>;
    error: Array<(err: Error) => void>;
  } = { data: [], close: [], error: [] };
  const channel: FakeChannel & { write: (b: Buffer) => void; end: () => void } = {
    writes: [],
    ended: false,
    setWindowCalls: [],
    emitData: (chunk) => {
      for (const cb of channelHandlers.data) cb(chunk);
    },
    emitClose: () => {
      for (const cb of channelHandlers.close) cb();
    },
    emitError: (err) => {
      for (const cb of channelHandlers.error) cb(err);
    },
    write: (b) => {
      channel.writes.push(b);
    },
    end: () => {
      channel.ended = true;
    },
  };
  const driver = {
    fireReady: () => {
      for (const cb of handlers.ready) cb();
    },
    fireError: (err: Error) => {
      for (const cb of handlers.error) cb(err);
    },
    fireEnd: () => {
      for (const cb of handlers.end) cb();
    },
    fireClose: () => {
      for (const cb of handlers.close) cb();
    },
    autoShell: true,
    shellError: undefined as Error | undefined,
    shellReturn: true,
    channel,
    connectCalls: [] as Array<Record<string, unknown>>,
    ended: false,
  };
  const client = {
    driver,
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === "ready") handlers.ready.push(cb as () => void);
      else if (event === "error") handlers.error.push(cb as (err: Error) => void);
      else if (event === "end") handlers.end.push(cb as () => void);
      else if (event === "close") handlers.close.push(cb as () => void);
      return client;
    },
    shell: (cb: (err: Error | undefined, stream: unknown) => void) => {
      if (driver.shellError) {
        cb(driver.shellError, undefined);
        return driver.shellReturn;
      }
      if (driver.autoShell) {
        // Wrap channel as ssh2.ClientChannel-like for the SUT.
        const stream = {
          on: (event: string, cb2: (...a: unknown[]) => void) => {
            if (event === "data") channelHandlers.data.push(cb2 as (c: Buffer) => void);
            else if (event === "close") channelHandlers.close.push(cb2 as () => void);
            else if (event === "error") channelHandlers.error.push(cb2 as (err: Error) => void);
            return stream;
          },
          stderr: {
            on: () => stream.stderr,
          },
          write: (b: Buffer) => channel.write(b),
          end: () => channel.end(),
          setWindow: (rows: number, cols: number, height: number, width: number) =>
            channel.setWindowCalls.push([rows, cols, height, width]),
        };
        cb(undefined, stream);
      }
      return driver.shellReturn;
    },
    connect: (cfg: Record<string, unknown>) => {
      driver.connectCalls.push(cfg);
      return client;
    },
    end: () => {
      driver.ended = true;
      return client;
    },
  } as unknown as FakeClient;
  return client;
}

function makeFactory(): { factory: Ssh2Factory; clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  const factory: Ssh2Factory = () => {
    const c = makeFakeClient();
    clients.push(c);
    return c;
  };
  return { factory, clients };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("SshClient", () => {
  test("relays SFTP bytes on the subsystem with no terminal shell", () => {
    const fake = makeFakeClient();
    const init = fake.shell.bind(fake);
    fake.shell = () => {
      throw new Error("unexpected shell");
    };
    fake.subsys = (name, cb) => {
      expect(name).toBe("sftp");
      init(cb);
      return fake;
    };
    const client = new SshClient({ ssh2Factory: () => fake, logger: silent });
    client.open("transfer", { host: "example.test", port: 22, username: "user", sftp: true });
    const bytes = Buffer.from([0, 27, 127, 255]);
    client.write("transfer", bytes);
    fake.driver.fireReady();
    expect(fake.driver.channel?.writes).toEqual([bytes]);
    const received: Buffer[] = [];
    client.onOutput((_session, data) => received.push(data));
    fake.driver.channel?.emitData(bytes);
    expect(received).toEqual([bytes]);
  });
  test("host-key pin installs a hostVerifier that accepts the match and rejects others", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const goodKey = Buffer.from("the-real-host-public-key");
    const expected = hostKeySha256(goodKey);
    client.open("s1", {
      host: "h",
      port: 22,
      username: "u",
      password: "p",
      expectedHostKeySha256: expected,
    });
    const cfg = clients[0]?.driver.connectCalls[0] as { hostVerifier?: (k: Buffer) => boolean };
    expect(typeof cfg.hostVerifier).toBe("function");
    expect(cfg.hostVerifier?.(goodKey)).toBe(true);
    expect(cfg.hostVerifier?.(Buffer.from("attacker-key"))).toBe(false);
  });

  test("a host-key mismatch surfaces a clear MITM close reason", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closed: string[] = [];
    client.onClosed((_sid, reason) => closed.push(reason));
    client.open("s1", {
      host: "h",
      port: 22,
      username: "u",
      password: "p",
      expectedHostKeySha256: "EXPECTED_PIN",
    });
    const cfg = clients[0]?.driver.connectCalls[0] as { hostVerifier?: (k: Buffer) => boolean };
    // ssh2 presents a non-matching host key → verifier rejects, then ssh2 errors.
    expect(cfg.hostVerifier?.(Buffer.from("wrong-host-key"))).toBe(false);
    clients[0]?.driver.fireError(new Error("Handshake failed"));
    expect(closed.some((r) => r.includes("host key verification failed"))).toBe(true);
  });

  test("without a pin, no hostVerifier is set (host key unverified)", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const cfg = clients[0]?.driver.connectCalls[0] as { hostVerifier?: unknown };
    expect(cfg.hostVerifier).toBeUndefined();
  });

  test("strictAlgorithms restricts the handshake to the modern allowlist", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent, strictAlgorithms: true });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const cfg = clients[0]?.driver.connectCalls[0] as {
      algorithms?: { cipher?: string[]; kex?: string[] };
    };
    expect(cfg.algorithms?.cipher).toContain("chacha20-poly1305@openssh.com");
    expect(cfg.algorithms?.cipher).not.toContain("3des-cbc");
    expect(cfg.algorithms?.kex).toContain("curve25519-sha256");
  });

  test("default (non-strict) leaves algorithms unset (ssh2 defaults)", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const cfg = clients[0]?.driver.connectCalls[0] as { algorithms?: unknown };
    expect(cfg.algorithms).toBeUndefined();
  });

  test("keepaliveIntervalMs sets keepalive on the connect config (count max 3)", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({
      ssh2Factory: factory,
      logger: silent,
      keepaliveIntervalMs: 30000,
    });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const cfg = clients[0]?.driver.connectCalls[0] as {
      keepaliveInterval?: number;
      keepaliveCountMax?: number;
    };
    expect(cfg.keepaliveInterval).toBe(30000);
    expect(cfg.keepaliveCountMax).toBe(3);
  });

  test("resize after the shell is open calls setWindow(rows, cols, 0, 0)", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    clients[0]?.driver.fireReady();
    client.resize("s1", 120, 40);
    expect(clients[0]?.driver.channel?.setWindowCalls).toEqual([[40, 120, 0, 0]]);
  });

  test("resize on an unknown session is a no-op", () => {
    const { factory } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    expect(() => client.resize("nope", 80, 24)).not.toThrow();
  });

  test("resize before the shell is open is buffered and applied when it opens", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    // The initial size frame typically arrives before ssh2's shell channel is
    // ready — it must not be lost, or the PTY stays at the default geometry.
    client.resize("s1", 120, 40);
    expect(clients[0]?.driver.channel?.setWindowCalls).toEqual([]);
    clients[0]?.driver.fireReady(); // channel opens → buffered size applied
    expect(clients[0]?.driver.channel?.setWindowCalls).toEqual([[40, 120, 0, 0]]);
  });

  test("only the latest pre-open resize is applied when the shell opens", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    client.resize("s1", 80, 24);
    client.resize("s1", 132, 43); // supersedes the first
    clients[0]?.driver.fireReady();
    expect(clients[0]?.driver.channel?.setWindowCalls).toEqual([[43, 132, 0, 0]]);
  });

  test("open → ready → shell → data flows to onOutput listener", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const outputs: Array<{ id: string; bytes: string }> = [];
    client.onOutput((id, data) => outputs.push({ id, bytes: data.toString() }));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });

    expect(clients).toHaveLength(1);
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    expect(fake.driver.connectCalls[0]).toMatchObject({
      host: "h",
      port: 22,
      username: "u",
      password: "p",
    });

    fake.driver.fireReady();
    fake.driver.channel?.emitData(Buffer.from("hello"));

    expect(outputs).toEqual([{ id: "s1", bytes: "hello" }]);
  });

  test("write before ready buffers, then flushes on shell open", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    client.write("s1", Buffer.from("ls\n"));

    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    // Channel doesn't exist yet — bytes are buffered, no writes recorded
    expect(fake.driver.channel?.writes ?? []).toHaveLength(0);

    fake.driver.fireReady();

    expect(fake.driver.channel?.writes.map((b) => b.toString())).toEqual(["ls\n"]);
  });

  test("write after ready forwards immediately", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    fake.driver.fireReady();

    client.write("s1", Buffer.from("pwd\n"));

    expect(fake.driver.channel?.writes.map((b) => b.toString())).toEqual(["pwd\n"]);
  });

  test("close emits onClosed exactly once and removes the session", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: Array<{ id: string; reason: string }> = [];
    client.onClosed((id, reason) => closes.push({ id, reason }));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    fake.driver.fireReady();

    client.close("s1", "user requested");
    // A second close call should be a no-op
    client.close("s1", "user requested");

    expect(closes).toEqual([{ id: "s1", reason: "user requested" }]);
    expect(client.activeCount()).toBe(0);
    expect(fake.driver.channel?.ended).toBe(true);
    expect(fake.driver.ended).toBe(true);
  });

  test("remote channel close flows through onClosed", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: string[] = [];
    client.onClosed((_id, reason) => closes.push(reason));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    fake.driver.fireReady();
    fake.driver.channel?.emitClose();

    expect(closes).toEqual(["channel closed"]);
    expect(client.activeCount()).toBe(0);
  });

  test("client error emits onClosed and tears down session", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: string[] = [];
    client.onClosed((_id, reason) => closes.push(reason));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    fake.driver.fireError(new Error("auth failed"));

    expect(closes[0]).toMatch(/client error: auth failed/);
    expect(client.activeCount()).toBe(0);
  });

  test("shell open error emits onClosed", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: string[] = [];
    client.onClosed((_id, reason) => closes.push(reason));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    const fake = clients[0];
    if (!fake) throw new Error("missing fake");
    fake.driver.shellError = new Error("no shell");
    fake.driver.fireReady();

    expect(closes[0]).toMatch(/shell open failed: no shell/);
  });

  test("opening with the same sessionId twice is a no-op", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });
    client.open("s1", { host: "h2", port: 22, username: "u", password: "p" });

    expect(clients).toHaveLength(1);
  });

  test("write to unknown session is a no-op", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    client.write("ghost", Buffer.from("x"));
    expect(clients).toHaveLength(0);
  });

  test("closeAll tears down every active session", () => {
    const { factory, clients } = makeFactory();
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: string[] = [];
    client.onClosed((_id, reason) => closes.push(reason));

    client.open("a", { host: "h", port: 22, username: "u", password: "p" });
    client.open("b", { host: "h", port: 22, username: "u", password: "p" });
    for (const f of clients) f.driver.fireReady();

    client.closeAll("shutdown");

    expect(closes.filter((r) => r === "shutdown").length).toBe(2);
    expect(client.activeCount()).toBe(0);
  });

  test("connect() throw is surfaced as onClosed", () => {
    const factory: Ssh2Factory = () => {
      const c = makeFakeClient();
      (c as unknown as { connect: () => never }).connect = () => {
        throw new Error("dns failure");
      };
      return c;
    };
    const client = new SshClient({ ssh2Factory: factory, logger: silent });
    const closes: string[] = [];
    client.onClosed((_id, reason) => closes.push(reason));

    client.open("s1", { host: "h", port: 22, username: "u", password: "p" });

    expect(closes[0]).toMatch(/connect threw: dns failure/);
  });
});

test.each([false, true])("a pinned jump forwards to the final channel (sftp=%s)", (sftp) => {
  const clients: FakeClient[] = [];
  const forwarded: string[] = [];
  const tunnel = {} as import("ssh2").ClientChannel;
  const ssh = new SshClient({
    logger: silent,
    ssh2Factory: () => {
      const c = makeFakeClient();
      c.forwardOut = (_src, _sp, host, port, done) => {
        forwarded.push(host + ":" + port);
        done(undefined, tunnel);
        return c;
      };
      clients.push(c);
      return c;
    },
  });
  const hop = {
    host: "jump.invalid",
    port: 22,
    username: "jump",
    password: "fixture-jump",
    expectedHostKeySha256: hostKeySha256(Buffer.from("jump")),
  };
  ssh.open("route", {
    ...hop,
    host: "dest.invalid",
    username: "dest",
    password: "fixture-dest",
    expectedHostKeySha256: hostKeySha256(Buffer.from("dest")),
    jumps: [hop],
    sftp,
  });
  const [dest, jump] = clients;
  if (!dest || !jump) throw new Error("missing SSH clients");
  expect(dest.driver.connectCalls).toHaveLength(0);
  const cfg = jump.driver.connectCalls[0];
  expect(cfg?.password).toBe("fixture-jump");
  expect((cfg?.hostVerifier as (key: Buffer) => boolean)(Buffer.from("jump"))).toBe(true);
  jump.driver.fireReady();
  expect(forwarded).toEqual(["dest.invalid:22"]);
  expect(dest.driver.connectCalls[0]?.sock).toBe(tunnel);
  expect(dest.driver.connectCalls[0]?.password).toBe("fixture-dest");
  if (sftp) {
    const open = dest.shell.bind(dest);
    dest.shell = () => {
      throw new Error("unexpected shell");
    };
    dest.subsys = (name, cb) => {
      expect(name).toBe("sftp");
      open(cb);
      return dest;
    };
  }
  dest.driver.fireReady();
  ssh.write("route", Buffer.from([0, 255]));
  expect(dest.driver.channel?.writes).toEqual([Buffer.from([0, 255])]);
  jump.driver.fireEnd();
  expect(ssh.activeCount()).toBe(0);
  expect(dest.driver.ended && jump.driver.ended).toBe(true);
});

test("late terminal and transport events cannot reach a reused session ID", () => {
  const { factory, clients } = makeFactory();
  const client = new SshClient({ ssh2Factory: factory, logger: silent });
  const data: Buffer[] = [];
  const reasons: string[] = [];
  client.onOutput((_id, chunk) => data.push(chunk));
  client.onClosed((_id, reason) => reasons.push(reason));
  const target = { host: "example.test", port: 22, username: "user" };
  client.open("reused", target);
  const old = clients[0]?.driver;
  if (!old) throw new Error("Missing original connection");
  old.fireReady();
  client.close("reused");
  client.open("reused", target);
  const current = clients[1]?.driver;
  if (!current) throw new Error("Missing replacement connection");
  current.fireReady();
  old.channel?.emitData(Buffer.from("old"));
  old.channel?.emitClose();
  old.fireEnd();
  old.fireClose();
  current.channel?.emitData(Buffer.from("new"));
  expect(data.map((b) => b.toString())).toEqual(["new"]);
  expect(reasons).toHaveLength(1);
  expect(client.activeCount()).toBe(1);
  client.closeAll();
});
