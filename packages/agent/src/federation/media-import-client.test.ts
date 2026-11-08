import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  FederationMediaImportGrantResponseSchema,
  FederationMediaImportSchema,
} from "@kuintessence/proto";
import {
  FederationMediaImportTaskSchema,
  FederationMediaKeyQuerySchema,
} from "@kuintessence/shared/federation";
import { AgentDataRoots } from "../data-market/local-data-security";
import { FederationMediaImportClient } from "./media-import-client";

function task() {
  return FederationMediaImportTaskSchema.parse({
    generation: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    authorizationId: crypto.randomUUID(),
    manifestDigest: `sha256:${"a".repeat(64)}`,
    agentId: "receiver",
    sourceSiteId: crypto.randomUUID(),
    recipientSiteId: crypto.randomUUID(),
    agreementRevisionId: crypto.randomUUID(),
    managedRootId: crypto.randomUUID(),
    maxBytes: 10,
    signedManifest: "unused.in.transport",
    signingKey: {
      keyId: "test",
      publicKeyPem: "unused in injected importer",
      validFrom: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}
const config = {
  agentId: "receiver",
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
  "expired",
] as const)("media import client binds ephemeral key and stops on %s", async (mode) => {
  const input = task();
  const requested = Promise.withResolvers<string>(),
    finished = Promise.withResolvers<string>();
  let wrote = false;
  let client: FederationMediaImportClient;
  client = new FederationMediaImportClient(
    config,
    (request) => {
      const { recipientKey, ...binding } = JSON.parse(request.bindingJson);
      expect(Object.keys(recipientKey).sort()).toEqual(["e", "kty", "n"]);
      requested.resolve(request.requestId);
      if (mode !== "disconnect")
        queueMicrotask(() => {
          const expiresAt = new Date(Date.now() + (mode === "expired" ? -1 : 30_000)).toISOString();
          const query = FederationMediaKeyQuerySchema.parse({
            protocolVersion: 1,
            kind: "media-key-query",
            queryId: crypto.randomUUID(),
            senderSiteId: input.recipientSiteId,
            recipientSiteId: input.sourceSiteId,
            packageId: input.packageId,
            agreementRevisionId: input.agreementRevisionId,
            manifestDigest: input.manifestDigest,
            authorizationId: input.authorizationId,
            agentId: input.agentId,
            managedRootId: input.managedRootId,
            recipientKey,
            maxBytes: input.maxBytes,
            authorizationExpiresAt: input.expiresAt,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          });
          if (mode === "wrong-scope") binding.authorizationId = crypto.randomUUID();
          client.receive(
            create(FederationMediaImportGrantResponseSchema, {
              requestId: request.requestId,
              grantJson:
                mode === "denied"
                  ? ""
                  : JSON.stringify({
                      binding,
                      query,
                      queryDigest: input.manifestDigest,
                      signedGrant: "verified.by.filesystem.importer",
                      signingKey: input.signingKey,
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
      expect(options.privateKey.extractable).toBe(false);
      expect(options.privateKey.type).toBe("private");
      await options.authorize(options.signal);
      wrote = true;
      return {
        generation: input.generation,
        packageId: input.packageId,
        authorizationId: input.authorizationId,
        manifestDigest: input.manifestDigest,
        state: "verified",
        queryDigest: input.manifestDigest,
        sizeBytes: 10,
      };
    },
  );
  try {
    client.start(
      create(FederationMediaImportSchema, {
        taskJson: JSON.stringify(input),
        leaseExpiresAtUnixMs: BigInt(Date.now() + 30_000),
      }),
    );
    const id = await requested.promise;
    if (mode === "disconnect") await client.disconnect();
    const result = JSON.parse(await finished.promise);
    expect(result.state).toBe(mode === "granted" ? "verified" : "failed");
    expect(result.authorizationId).toBe(input.authorizationId);
    expect(wrote).toBe(mode === "granted");
    expect(client.hasPending(id)).toBe(false);
  } finally {
    await client.disconnect();
  }
});
