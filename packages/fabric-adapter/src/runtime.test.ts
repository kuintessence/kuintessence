import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommercialHttpServer } from "./commercial-runtime";
import { createEvidenceHttpServer } from "./runtime";

test.each([
  "evidence",
  "commercial",
] as const)("%s Unix HTTP surface is allowlisted, strict and never exposes private details", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "kq-evidence-http-"));
  let calls = 0;
  const createHttpServer =
    kind === "evidence" ? createEvidenceHttpServer : createCommercialHttpServer;
  const server = createHttpServer({
    prepare: async () => {
      throw new Error("unexpected prepare");
    },
    advance: async () => {
      calls++;
      throw new Error("private-price=12; signature=secret");
    },
  });
  const socket = join(directory, "adapter.sock");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const send = (path: string, body: unknown, method = "POST") =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(
          { socketPath: socket, path, method, headers: { "content-type": "application/json" } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      });
    expect(await send("/health", null, "GET")).toEqual({
      status: 200,
      text: '{"configured":true}',
    });
    expect((await send("/invoke", { channel: "other", chaincode: "other" })).status).toBe(404);
    expect((await send(`/v1/${kind}/advance`, { recovery: "eA==", channel: "other" })).status).toBe(
      409,
    );
    expect(
      (await send(`/v1/${kind}/proposal`, { envelope: { issuerJws: "sensitive" } })).status,
    ).toBe(409);
    expect(
      (
        await send(`/v1/${kind === "evidence" ? "commercial" : "evidence"}/advance`, {
          recovery: "eA==",
        })
      ).status,
    ).toBe(404);
    expect(calls).toBe(0);
    const response = await send(`/v1/${kind}/advance`, { recovery: "eA==" });
    expect(response).toEqual({ status: 503, text: '{"code":"LEDGER_UNAVAILABLE"}' });
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
