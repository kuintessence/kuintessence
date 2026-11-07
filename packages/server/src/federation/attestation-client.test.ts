import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixAttestationClient } from "./attestation-client";
import { UnixCommercialClient } from "./commercial-client";

test.each([
  "evidence",
  "commercial",
] as const)("%s Unix client enforces private socket and strict replies without leaking adapter errors", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "kq-attestation-client-"));
  const socket = join(directory, `${kind}.sock`);
  let mode = "pending";
  let calls = 0;
  const recovery = Buffer.from("encrypted-fixture").toString("base64");
  const transactionId = "a".repeat(64);
  const server = createServer(async (req, res) => {
    calls++;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`/v1/${kind}/advance`);
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    expect(JSON.parse(Buffer.concat(parts).toString())).toEqual({ recovery });
    res.setHeader("content-type", "application/json");
    if (mode === "offline") res.writeHead(503).end('{"code":"LEDGER_UNAVAILABLE"}');
    else if (["BUDGET_EXHAUSTED", "DATA_WAITING", "AGREEMENT_UNAVAILABLE"].includes(mode))
      res.writeHead(409).end(JSON.stringify({ code: mode }));
    else if (mode === "bad") res.writeHead(500).end('{"error":"private contract payload"}');
    else if (mode === "committed" || mode === "anchored")
      res.end(JSON.stringify({ state: mode, transactionId, blockNumber: "1" }));
    else if (mode === "invalid")
      res.end(
        JSON.stringify({ state: "invalid", transactionId, validationCode: 0, blockNumber: "1" }),
      );
    else res.end(JSON.stringify({ state: "pending", transactionId, recovery }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    const client =
      kind === "evidence" ? new UnixAttestationClient(socket) : new UnixCommercialClient(socket);
    expect(await client.advance(recovery)).toEqual({ state: "pending", transactionId, recovery });
    const committedState = kind === "evidence" ? "anchored" : "committed";
    mode = committedState;
    expect(await client.advance(recovery)).toEqual({
      state: committedState,
      transactionId,
      blockNumber: "1",
    });
    mode = kind === "evidence" ? "committed" : "anchored";
    await expect(client.advance(recovery)).rejects.toThrow();
    mode = "offline";
    await expect(client.advance(recovery)).rejects.toMatchObject({
      code: "LEDGER_UNAVAILABLE",
      needsReview: false,
    });
    for (const code of ["BUDGET_EXHAUSTED", "DATA_WAITING", "AGREEMENT_UNAVAILABLE"]) {
      mode = code;
      await expect(client.advance(recovery)).rejects.toMatchObject({
        code,
        needsReview: code !== "DATA_WAITING",
      });
    }
    mode = "bad";
    await expect(client.advance(recovery)).rejects.toMatchObject({
      code: "INVALID_ADAPTER_RESPONSE",
      needsReview: true,
    });
    mode = "invalid";
    await expect(client.advance(recovery)).rejects.toThrow();
    const before = calls;
    await chmod(directory, 0o755);
    await expect(client.advance(recovery)).rejects.toMatchObject({
      code: "UNSAFE_ADAPTER_SOCKET",
      needsReview: true,
    });
    expect(calls).toBe(before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
