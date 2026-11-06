import { expect, test } from "bun:test";
import { clone, create } from "@bufbuild/protobuf";
import {
  FederationExecutionDecision as Decision,
  DispatchJobSchema,
  type FederationExecutionRequest,
  FederationExecutionResponseSchema,
  InputStagingSchema,
} from "@kuintessence/proto";
import { FederationExecutionClient } from "./federation-execution";

const original = create(DispatchJobSchema, {
  jobId: crypto.randomUUID(),
  dispatchEpoch: 1n,
  federationExecution: true,
  command: "frozen-command",
  cpus: 1,
});
const options = { now: () => 1000, timeoutMs: 20, retryMs: 1 };
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
