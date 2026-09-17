/**
 * Real-`ssh2` integration test for the Agent SSH relay (PRD F17).
 *
 * This is the ONLY test that exercises `SshClient` against a real sshd instead
 * of the fake ssh2 factory — it validates the actual handshake, the shell
 * output round-trip, and (critically) that host-key pinning accepts the real
 * key and rejects a wrong one.
 *
 * Runs under `bun run test:integration` with a reachable Docker daemon; it
 * `skipIf`s cleanly otherwise. Verified green (3/3) against
 * `lscr.io/linuxserver/openssh-server` on a live daemon.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SshClient } from "../../src/ssh/client";
import {
  dockerAvailable,
  type SshdContainer,
  startSshdContainer,
} from "../fixtures/sshd-container";

const HAS_DOCKER = await dockerAvailable();

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await Bun.sleep(100);
  }
}

describe.skipIf(!HAS_DOCKER)("SshClient — real sshd", () => {
  let c: SshdContainer;

  beforeAll(async () => {
    c = await startSshdContainer();
  }, 180_000);

  afterAll(async () => {
    await c?.stop();
  });

  test("shell round-trip: a command's output flows back", async () => {
    const client = new SshClient({});
    let out = "";
    client.onOutput((_sid, data) => {
      out += data.toString("utf8");
    });
    client.open("s1", { host: c.host, port: c.port, username: c.username, password: c.password });
    await waitUntil(() => out.length > 0, 20_000); // shell banner / prompt
    client.write("s1", Buffer.from("echo SSH_RELAY_OK\n"));
    await waitUntil(() => out.includes("SSH_RELAY_OK"), 20_000);
    expect(out).toContain("SSH_RELAY_OK");
    client.close("s1", "done");
  }, 45_000);

  test("a wrong host-key pin rejects the connection (MITM defense)", async () => {
    const client = new SshClient({});
    let closedReason = "";
    client.onClosed((_sid, reason) => {
      closedReason = reason;
    });
    client.open("s2", {
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      expectedHostKeySha256: "ZGVsaWJlcmF0ZWx5LXdyb25nLXBpbg==", // not the real key
    });
    await waitUntil(() => closedReason.length > 0, 20_000);
    expect(closedReason).toContain("host key verification failed");
  }, 45_000);

  test("the correct host-key pin allows the connection", async () => {
    const client = new SshClient({});
    let out = "";
    let closedReason = "";
    client.onOutput((_sid, data) => {
      out += data.toString("utf8");
    });
    client.onClosed((_sid, reason) => {
      closedReason = reason;
    });
    client.open("s3", {
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password,
      expectedHostKeySha256: c.hostKeySha256,
    });
    await waitUntil(() => out.length > 0 || closedReason.length > 0, 20_000);
    expect(closedReason).not.toContain("host key verification failed");
    expect(out.length).toBeGreaterThan(0);
    client.close("s3", "done");
  }, 45_000);
});
