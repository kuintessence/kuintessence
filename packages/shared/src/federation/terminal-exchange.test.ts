import { expect, test } from "bun:test";
import { federationCanonicalJson } from "./assets";
import { TERMINAL_MAX_BYTES, TerminalQuerySchema } from "./terminal-exchange";
import { FederationKeyInput } from "./trust";

test("terminal transport binds a short lived cursor and has explicit distinct signing purposes", () => {
  const id = () => crypto.randomUUID(),
    digest = `sha256:${"a".repeat(64)}`;
  const query = {
    protocolVersion: 1,
    kind: "terminal-query",
    queryId: id(),
    senderSiteId: id(),
    recipientSiteId: id(),
    operationId: id(),
    agreementRevisionId: id(),
    taskId: id(),
    attempt: 1,
    reservationId: id(),
    requestDigest: digest,
    agreementDigest: digest,
    issuedAt: "2026-11-08T00:00:00Z",
    expiresAt: "2026-11-08T00:01:00Z",
    terminalId: null,
    proposalDigest: null,
    offset: 0,
  };
  expect(TerminalQuerySchema.safeParse(query).success).toBe(true);
  for (const patch of [
    { offset: 1 },
    { offset: 65536 },
    { terminalId: id() },
    { expiresAt: "2026-11-08T00:01:01Z" },
    { senderSiteId: query.recipientSiteId },
  ])
    expect(TerminalQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
  expect(
    TerminalQuerySchema.safeParse({
      ...query,
      terminalId: id(),
      proposalDigest: digest,
      offset: 65536,
    }).success,
  ).toBe(true);
  const kinds = FederationKeyInput.shape.allowedKinds.element.options;
  for (const kind of [
    "terminal-query",
    "terminal-chunk",
    "terminal-delivery",
    "terminal-ack",
  ] as const)
    expect(kinds).toContain(kind);
  expect(FederationKeyInput.shape.allowedKinds.safeParse(kinds).success).toBe(true);
});
test("terminal canonical byte limit expands only when explicitly requested and preserves existing digests", () => {
  const body = { data: "x".repeat(1048576) };
  expect(() => federationCanonicalJson(body)).toThrow("MiB");
  expect(federationCanonicalJson(body, TERMINAL_MAX_BYTES)).toBe(JSON.stringify(body));
  expect(federationCanonicalJson({ z: 1, a: 2 }, TERMINAL_MAX_BYTES)).toBe(
    federationCanonicalJson({ z: 1, a: 2 }),
  );
  expect(() => federationCanonicalJson("x".repeat(TERMINAL_MAX_BYTES), TERMINAL_MAX_BYTES)).toThrow(
    "MiB",
  );
});
