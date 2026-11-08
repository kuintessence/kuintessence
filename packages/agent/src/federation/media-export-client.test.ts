import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  FederationMediaExportLeaseResponseSchema,
  FederationMediaExportSchema,
} from "@kuintessence/proto";
import {
  FederationMediaExportReceiptSchema,
  FederationMediaExportTaskSchema,
} from "@kuintessence/shared/federation";
import { AgentDataRoots } from "../data-market/local-data-security";
import { FederationMediaExportClient } from "./media-export-client";

function task() {
  return FederationMediaExportTaskSchema.parse({
    generation: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    agentId: "test-agent",
    sourceSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    managedRootId: crypto.randomUUID(),
    relativePath: "v1",
    recipient: `age1${"a".repeat(58)}`,
    signedManifest: "unused.in.transport",
    signingKey: {
      keyId: "test",
      publicKeyPem: "unused in injected export",
      validFrom: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}
const config = {
  agentId: "test-agent",
  mediaDirectory: "/unused/media",
  ageDirectory: "/unused/age",
  roots: new AgentDataRoots({
    datasetRoot: "/unused/data",
    jobWorkRoot: "/unused/jobs",
    managedRoots: {},
  }),
};

test.each([
  "granted",
  "wrong-scope",
  "denied",
  "disconnect",
] as const)("media export client binds lease and stops on %s", async (mode) => {
  const input = task();
  const requested = Promise.withResolvers<string>();
  const finished = Promise.withResolvers<string>();
  let wrote = false;
  let client: FederationMediaExportClient;
  client = new FederationMediaExportClient(
    config,
    (request) => {
      requested.resolve(request.requestId);
      if (mode !== "disconnect")
        queueMicrotask(() => {
          const expiresAt = new Date(Date.now() + 30_000).toISOString();
          client.receive(
            create(FederationMediaExportLeaseResponseSchema, {
              requestId: request.requestId,
              grantJson:
                mode === "denied"
                  ? ""
                  : JSON.stringify({
                      generation: mode === "wrong-scope" ? crypto.randomUUID() : input.generation,
                      packageId: input.packageId,
                      manifestDigest: input.manifestDigest,
                      expiresAt,
                    }),
              leaseExpiresAtUnixMs: BigInt(Date.parse(expiresAt)),
            }),
          );
        });
      return true;
    },
    (report) => finished.resolve(report.reportJson),
    undefined,
    async (options) => {
      await options.authorize(options.signal);
      wrote = true;
      return {
        generation: input.generation,
        packageId: input.packageId,
        manifestDigest: input.manifestDigest,
        sha256: "b".repeat(64),
        sizeBytes: 100,
      };
    },
  );
  client.start(
    create(FederationMediaExportSchema, {
      taskJson: JSON.stringify(input),
      leaseExpiresAtUnixMs: BigInt(Date.now() + 30_000),
    }),
  );
  const requestId = await requested.promise;
  if (mode === "disconnect") await client.disconnect();
  const report = JSON.parse(await finished.promise);
  expect(report.state).toBe(mode === "granted" ? "exported" : "failed");
  if (mode === "granted")
    expect(
      FederationMediaExportReceiptSchema.safeParse({
        generation: report.generation,
        packageId: report.packageId,
        manifestDigest: report.manifestDigest,
        sha256: report.sha256,
        sizeBytes: report.sizeBytes,
      }).success,
    ).toBe(true);
  expect(wrote).toBe(mode === "granted");
  expect(client.hasPending(requestId)).toBe(false);
  await client.disconnect();
});

test("media export expiry aborts active work when the Server cannot renew", async () => {
  const input = task();
  const finished = Promise.withResolvers<string>();
  let stopped = false;
  const client = new FederationMediaExportClient(
    config,
    () => false,
    (report) => finished.resolve(report.reportJson),
    undefined,
    async ({ signal }) => {
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.throwIfAborted();
          signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(new Error("expired"));
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      } finally {
        stopped = true;
      }
    },
  );
  client.start(
    create(FederationMediaExportSchema, {
      taskJson: JSON.stringify(input),
      leaseExpiresAtUnixMs: BigInt(Date.now() + 100),
    }),
  );
  expect(JSON.parse(await finished.promise).state).toBe("failed");
  expect(stopped).toBe(true);
  await client.disconnect();
});
