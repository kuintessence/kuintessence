import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import {
  FederationExecutionDecision as Decision,
  DispatchJobSchema,
  type FederationExecutionRequest,
  FederationExecutionResponseSchema,
  InputStagingSchema,
  SoftwareOperationAction,
  SoftwareOperationRequestSchema,
} from "@kuintessence/proto";
import { SpackInstallationPending } from "../spack/execution-identity";
import { FederationExecutionClient } from "./federation-execution";

const original = create(DispatchJobSchema, {
  jobId: crypto.randomUUID(),
  dispatchEpoch: 1n,
  federationExecution: true,
  command: "frozen-command",
  cpus: 1,
});
const options = { now: () => 1000, timeoutMs: 20, retryMs: 1 };

test.each([
  "grant",
  "dispatch",
  "installation",
  "legacy",
  "epoch",
] as const)("runtime grant accepts only continuation authority: %s", async (kind) => {
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    expect(request.runtimeRenewal).toBe(true);
    expect(request.operationId).toBe("");
    client.receive(
      create(FederationExecutionResponseSchema, {
        requestId: request.requestId,
        jobId: request.jobId,
        dispatchEpoch: kind === "epoch" ? request.dispatchEpoch + 1n : request.dispatchEpoch,
        runtimeRenewal: kind !== "legacy",
        decision: Decision.GRANTED,
        expiresAtUnixMs: 2000n,
        ...(kind === "dispatch" ? { dispatch: original } : {}),
        ...(kind === "installation"
          ? { installation: create(SoftwareOperationRequestSchema) }
          : {}),
      }),
    );
    return true;
  }, options);
  const result = client.renewRuntime(
    original.jobId,
    original.dispatchEpoch,
    new AbortController().signal,
  );
  if (kind === "grant") expect(await result).toBe(2000);
  else await expect(result).rejects.toThrow();
});
function response(request: FederationExecutionRequest) {
  return create(FederationExecutionResponseSchema, {
    requestId: request.requestId,
    jobId: request.jobId,
    dispatchEpoch: request.dispatchEpoch,
    decision: Decision.GRANTED,
    expiresAtUnixMs: 2000n,
    dispatch: clone(DispatchJobSchema, original),
  });
}

test("fresh grants are requested at each boundary and never cached", async () => {
  const ids: string[] = [];
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    ids.push(request.requestId);
    client.receive(response(request));
    return true;
  }, options);
  const signal = new AbortController().signal;
  await client.renew(original, signal);
  await client.renew(original, signal);
  expect(new Set(ids).size).toBe(2);
  expect(client.hasPending(ids[0] ?? "")).toBe(false);
});

test.each([
  "deny",
  "job",
  "epoch",
  "command",
  "long-expiry",
  "missing-dispatch",
  "unspecified",
] as const)("refuses a %s grant", async (change) => {
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    const reply = response(request);
    switch (change) {
      case "deny":
        reply.decision = Decision.DENIED;
        break;
      case "job":
        reply.jobId = crypto.randomUUID();
        break;
      case "epoch":
        reply.dispatchEpoch++;
        break;
      case "command":
        if (reply.dispatch) reply.dispatch.command = "replacement";
        break;
      case "long-expiry":
        reply.expiresAtUnixMs = 100_000n;
        break;
      case "missing-dispatch":
        reply.dispatch = undefined;
        break;
      case "unspecified":
        reply.decision = Decision.UNSPECIFIED;
        break;
    }
    client.receive(reply);
    return true;
  }, options);
  await expect(client.renew(original, new AbortController().signal)).rejects.toThrow();
});

test.each([
  "expired",
  "retry",
  "disconnect",
  "timeout",
  "offline",
] as const)("%s waits for a fresh response without accepting the old one", async (reason) => {
  let attempts = 0;
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    attempts++;
    if (attempts === 1) {
      if (reason === "offline") return false;
      if (reason === "disconnect") {
        client.disconnect();
        return true;
      }
      if (reason === "timeout") return true;
      const reply = response(request);
      if (reason === "retry") reply.decision = Decision.RETRY;
      else reply.expiresAtUnixMs = 999n;
      client.receive(reply);
    } else client.receive(response(request));
    return true;
  }, options);
  expect((await client.renew(original, new AbortController().signal)).expiresAt).toBe(2000);
  expect(attempts).toBe(2);
});

test("cancellation interrupts a pending request and discards late responses", async () => {
  let requested: FederationExecutionRequest | undefined;
  const client = new FederationExecutionClient((request) => {
    requested = request;
    return true;
  }, options);
  const controller = new AbortController();
  const pending = client.renew(original, controller.signal);
  controller.abort(new Error("job cancelled"));
  await expect(pending).rejects.toThrow("job cancelled");
  if (!requested) throw new Error("Missing request");
  expect(client.hasPending(requested.requestId)).toBe(false);
  client.receive(response(requested));
});

test.each(["ordinary-url", "federation-flag"])("renewal cannot rewrite %s", async (field) => {
  const initial = create(DispatchJobSchema, {
    ...original,
    inputStaging: [
      create(InputStagingSchema, {
        fileMetadataId: "input",
        stagePath: "input.txt",
        sourceUrl: "https://objects.test/fixed",
      }),
    ],
  });
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    const reply = response(request);
    reply.dispatch = clone(DispatchJobSchema, initial);
    if (field === "federation-flag") reply.dispatch.federationExecution = false;
    else {
      const input = reply.dispatch.inputStaging[0];
      if (!input) throw new Error("Missing input");
      input.sourceUrl = "https://objects.test/replacement";
    }
    client.receive(reply);
    return true;
  }, options);
  await expect(client.renew(initial, new AbortController().signal)).rejects.toThrow("invalid");
});

test.each([
  "ticket",
  "owner",
  "operation",
  "spec",
  "manifest",
  "missing-marker",
  "wrong-response-kind",
] as const)("installation renewal preserves authority: %s", async (change) => {
  const initial = create(SoftwareOperationRequestSchema, {
    operationId: crypto.randomUUID(),
    federationJobId: crypto.randomUUID(),
    action: SoftwareOperationAction.INSTALL,
    spec: "hello@1",
    requestedBy: "owner",
    durableReplay: true,
    spackManifestDigest: `sha256:${"a".repeat(64)}`,
    spackMaterialTicket: "old",
  });
  const client: FederationExecutionClient = new FederationExecutionClient((request) => {
    const installation = clone(SoftwareOperationRequestSchema, initial);
    installation.spackMaterialTicket = "new";
    if (change === "owner") installation.federationJobId = crypto.randomUUID();
    if (change === "operation") installation.operationId = crypto.randomUUID();
    if (change === "spec") installation.spec = "other@1";
    if (change === "manifest") installation.spackManifestDigest = `sha256:${"b".repeat(64)}`;
    if (change === "missing-marker") installation.federationJobId = "";
    client.receive(
      create(FederationExecutionResponseSchema, {
        requestId: request.requestId,
        jobId: request.jobId,
        dispatchEpoch: request.dispatchEpoch,
        operationId: request.operationId,
        decision: Decision.GRANTED,
        expiresAtUnixMs: 2000n,
        installation,
        ...(change === "wrong-response-kind" ? { dispatch: original } : {}),
      }),
    );
    return true;
  }, options);
  const pending = client.renewInstallation(initial, new AbortController().signal);
  if (change === "ticket") expect((await pending).installation.spackMaterialTicket).toBe("new");
  else await expect(pending).rejects.toThrow("invalid");
});

test.each([
  "offline",
  "timeout",
  "retry",
  "deny",
  "cancel",
] as const)("bounded installation authority wait classifies %s", async (kind) => {
  const initial = create(SoftwareOperationRequestSchema, {
    operationId: crypto.randomUUID(),
    federationJobId: crypto.randomUUID(),
    action: SoftwareOperationAction.INSTALL,
    spec: "hello@1",
    requestedBy: "owner",
    durableReplay: true,
    spackManifestDigest: `sha256:${"a".repeat(64)}`,
    spackMaterialTicket: "old",
  });
  const requests: string[] = [];
  const controller = new AbortController();
  const client: FederationExecutionClient = new FederationExecutionClient(
    (request) => {
      requests.push(request.requestId);
      if (kind === "offline") return false;
      if (kind === "cancel") controller.abort(new Error("cancelled"));
      if (kind === "retry" || kind === "deny")
        client.receive(
          create(FederationExecutionResponseSchema, {
            requestId: request.requestId,
            jobId: request.jobId,
            operationId: request.operationId,
            decision: kind === "deny" ? Decision.DENIED : Decision.RETRY,
          }),
        );
      return true;
    },
    { ...options, installationWaitMs: 15, retryMs: 30 },
  );
  const pending = client.renewInstallation(initial, controller.signal);
  if (kind === "deny" || kind === "cancel")
    await expect(pending).rejects.toThrow(kind === "deny" ? "denied" : "cancelled");
  else await expect(pending).rejects.toBeInstanceOf(SpackInstallationPending);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((id) => !client.hasPending(id))).toBe(true);
});
