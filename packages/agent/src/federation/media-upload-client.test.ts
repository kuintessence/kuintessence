import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  type FederationInputCopyReport,
  FederationInputGrantResponseSchema,
  FederationMediaImportGrantResponseSchema,
  FederationMediaUploadSchema,
  type FederationResultCopyReport,
  FederationResultGrantResponseSchema,
} from "@kuintessence/proto";
import {
  FederationMediaImportKeyRequestSchema,
  FederationMediaKeyQuerySchema,
} from "@kuintessence/shared/federation";
import { AgentDataRoots } from "../data-market/local-data-security";
import { FederationMediaUploadClient } from "./media-upload-client";
import { mediaUploadClientTask } from "./media-upload-client-test-fixture";
import { FederationTransferSlot } from "./transfer-session";

const roots = new AgentDataRoots({
  datasetRoot: "/unused/data",
  jobWorkRoot: "/unused/jobs",
  managedRoots: {},
});
for (const kind of ["task-input", "task-result"] as const) {
  test.each([
    "granted",
    "slow-hash",
    "wrong-media",
    "wrong-target",
    "wrong-part",
    "wrong-direction",
    "source-expired",
    "destination-expired",
    "overlong",
    "denied",
    "disconnect",
    "wrong-channel",
  ] as const)(`media upload client ${kind} binds both grants: %s`, async (mode) => {
    const task = mediaUploadClientTask(kind);
    const finished = Promise.withResolvers<
      FederationInputCopyReport | FederationResultCopyReport
    >();
    const requested = Promise.withResolvers<string>();
    const requests: string[] = [];
    let sourceUntil = 0;
    let uploaded = false;
    let client: FederationMediaUploadClient;
    const destination = (request: {
      requestId: string;
      bindingJson: string;
      upload: boolean;
      partNumber?: number;
    }) => {
      requests.push("target");
      expect(request.upload).toBe(true);
      expect(request.partNumber).toBe(1);
      const binding = JSON.parse(request.bindingJson);
      const deadline = mode === "destination-expired" ? Date.now() - 1 : sourceUntil;
      const expiresAt = new Date(mode === "overlong" ? sourceUntil + 1 : deadline).toISOString();
      if (mode === "wrong-target") binding.generation = crypto.randomUUID();
      const body = {
        requestId: request.requestId,
        grantJson: JSON.stringify({
          binding,
          direction: mode === "wrong-direction" ? "download" : "upload",
          partNumber: mode === "wrong-part" ? 2 : 1,
          url: "https://storage.test.invalid/part",
          expiresAt,
        }),
        leaseExpiresAtUnixMs: BigInt(mode === "overlong" ? sourceUntil + 500 : deadline),
      };
      queueMicrotask(() => {
        if (kind === "task-input")
          client.receive("input", create(FederationInputGrantResponseSchema, body));
        else client.receive("result", create(FederationResultGrantResponseSchema, body));
      });
      return true;
    };
    client = new FederationMediaUploadClient(
      {
        agentId: task.media.agentId,
        roots,
        inputOrigins: ["https://storage.test.invalid"],
        resultOrigins: ["https://storage.test.invalid"],
      },
      {
        media: (request) => {
          requests.push("source");
          requested.resolve(request.requestId);
          const parsed = FederationMediaImportKeyRequestSchema.parse(
            JSON.parse(request.bindingJson),
          );
          expect(parsed.purpose).toBe("task-upload");
          expect(parsed.generation).toBe(task.media.generation);
          expect(parsed.generation).not.toBe(task.target.binding.generation);
          const { purpose: _purpose, recipientKey, ...binding } = parsed;
          sourceUntil = Date.now() + (mode === "source-expired" ? -1 : 30_000);
          const query = FederationMediaKeyQuerySchema.parse({
            protocolVersion: 1,
            kind: "media-key-query",
            queryId: crypto.randomUUID(),
            senderSiteId: task.media.recipientSiteId,
            recipientSiteId: task.media.sourceSiteId,
            packageId: task.media.packageId,
            agreementRevisionId: task.media.agreementRevisionId,
            manifestDigest: task.media.manifestDigest,
            authorizationId: task.media.authorizationId,
            agentId: task.media.agentId,
            managedRootId: task.media.managedRootId,
            recipientKey,
            maxBytes: task.media.maxBytes,
            authorizationExpiresAt: task.media.expiresAt,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
          });
          if (mode === "wrong-media") binding.authorizationId = crypto.randomUUID();
          if (mode !== "disconnect")
            queueMicrotask(() => {
              const response = create(FederationMediaImportGrantResponseSchema, {
                requestId: request.requestId,
                grantJson:
                  mode === "denied"
                    ? ""
                    : JSON.stringify({
                        binding,
                        query,
                        queryDigest: task.media.manifestDigest,
                        signedGrant: "checked.by.upload.primitive",
                        signingKey: task.media.signingKey,
                        expiresAt: new Date(sourceUntil).toISOString(),
                      }),
                leaseExpiresAtUnixMs: BigInt(sourceUntil),
              });
              if (mode === "wrong-channel") {
                client.receive("result", response);
                expect(client.hasPending("media", request.requestId)).toBe(true);
              }
              client.receive("media", response);
            });
          return true;
        },
        input: destination,
        result: destination,
        inputReport: (report) => {
          expect(kind).toBe("task-input");
          finished.resolve(report);
        },
        resultReport: (report) => {
          expect(kind).toBe("task-result");
          finished.resolve(report);
        },
      },
      undefined,
      async (options) => {
        await options.authorizeMedia(options.signal);
        if (mode === "slow-hash") await Bun.sleep(1200);
        await options.authorizeUpload(options.task.target, 1, options.signal);
        uploaded = true;
        return {
          media: {
            generation: task.media.generation,
            authorizationId: task.media.authorizationId,
            packageId: task.media.packageId,
            manifestDigest: task.media.manifestDigest,
          },
          memberIndex: 0,
          kind,
          copied: {
            sizeBytes: 3,
            sha256: task.target.binding.sha256,
            parts: [{ partNumber: 1, etag: "part" }],
            ...(task.target.kind === "task-input"
              ? { binding: task.target.binding }
              : { binding: task.target.binding }),
          },
        };
      },
    );
    try {
      const command = create(FederationMediaUploadSchema, {
        taskJson: JSON.stringify(task),
        leaseExpiresAtUnixMs: BigInt(Date.now() + (mode === "slow-hash" ? 1000 : 30_000)),
      });
      client.start(command);
      client.start(command);
      const requestId = await requested.promise;
      if (mode === "disconnect") await client.disconnect();
      const report = await finished.promise;
      const success = mode === "granted" || mode === "wrong-channel" || mode === "slow-hash";
      expect(report.generation).toBe(task.target.binding.generation);
      expect(report.failed).toBe(!success);
      expect(uploaded).toBe(success);
      expect(client.hasPending("media", requestId)).toBe(false);
      if (success) {
        expect(requests).toEqual(["source", "target", "target"]);
        expect(JSON.parse(report.copiedJson).binding).toEqual(task.target.binding);
      }
    } finally {
      await client.disconnect();
    }
  });
}

test("media upload client shares the transfer slot and drops malformed or foreign commands", async () => {
  const task = mediaUploadClientTask("task-input");
  const slot = new FederationTransferSlot();
  const release = slot.acquire();
  const reports: string[] = [];
  let grants = 0;
  const client = new FederationMediaUploadClient(
    { agentId: task.media.agentId, roots, inputOrigins: ["https://storage.test.invalid"] },
    {
      media: () => {
        grants++;
        return false;
      },
      input: () => false,
      result: () => false,
      inputReport: (report) => {
        expect(report.failed).toBe(true);
        reports.push(report.generation);
      },
      resultReport: () => {
        throw new Error("Wrong report channel");
      },
    },
    slot,
  );
  try {
    for (const taskJson of [
      "{",
      JSON.stringify({ ...task, unknown: true }),
      JSON.stringify({ ...task, media: { ...task.media, agentId: "foreign" } }),
      " ".repeat(512 * 1024 + 1),
    ])
      client.start(
        create(FederationMediaUploadSchema, {
          taskJson,
          leaseExpiresAtUnixMs: BigInt(Date.now() + 30_000),
        }),
      );
    expect(reports).toEqual([]);
    client.start(
      create(FederationMediaUploadSchema, {
        taskJson: JSON.stringify(task),
        leaseExpiresAtUnixMs: BigInt(Date.now() + 30_000),
      }),
    );
    expect(reports).toEqual([task.target.binding.generation]);
    expect(grants).toBe(0);
  } finally {
    release?.();
    await client.disconnect();
  }
});
