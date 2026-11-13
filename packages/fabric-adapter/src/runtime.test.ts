import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommercialHttpServer } from "./commercial-runtime";
import { createMarketHttpServer } from "./market-runtime";
import { createEvidenceHttpServer } from "./runtime";

test.each([
  "evidence",
  "commercial",
  "market",
] as const)("%s Unix HTTP surface is allowlisted, strict and never exposes private details", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "kq-evidence-http-"));
  let calls = 0;
  const adapter = {
    prepare: async () => {
      throw new Error("unexpected prepare");
    },
    advance: async () => {
      calls++;
      throw new Error("private-price=12; signature=secret");
    },
  };
  const server =
    kind === "market"
      ? createMarketHttpServer({
          ...adapter,
          query: async () => {
            calls++;
            return { operation: "list-demands" as const, demands: [], bookmark: "" };
          },
        })
      : kind === "commercial"
        ? createCommercialHttpServer({
            ...adapter,
            receipt: async () => ({ receipt: null }),
            query: async () => {
              calls++;
              return { hash: null };
            },
          })
        : createEvidenceHttpServer(adapter);
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
    const query =
      kind === "commercial"
        ? {
            operation: "get-execution-gate-hash",
            domainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            reservationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }
        : { operation: "list-demands", limit: 10, bookmark: "" };
    expect((await send(`/v1/${kind}/query`, query)).status).toBe(kind === "evidence" ? 404 : 200);
    expect((await send(`/v1/${kind}/query`, { ...query, chaincode: "other" })).status).toBe(
      kind === "evidence" ? 404 : 409,
    );
    expect(calls).toBe(kind === "evidence" ? 1 : 2);
    if (kind === "commercial") {
      const receipt = {
        operation: "get-commercial-receipt",
        domainId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        recordType: "agreement",
        recordId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      expect(await send("/v1/commercial/query", receipt)).toEqual({
        status: 200,
        text: '{"receipt":null}',
      });
      expect((await send("/v1/commercial/query", { ...receipt, collection: "other" })).status).toBe(
        409,
      );
      expect(
        (await send("/v1/commercial/query", { ...receipt, recordType: "budget" })).status,
      ).toBe(409);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
