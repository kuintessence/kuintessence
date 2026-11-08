import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommercialAgreementApprovalSchema,
  CommercialBillSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import { Command } from "commander";
import { registerFederationCommand } from "./federation";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const billId = "11111111-1111-4111-8111-111111111111",
  reportId = "22222222-2222-4222-8222-222222222222";
const digest = `sha256:${"a".repeat(64)}`;
const approval = CommercialAgreementApprovalSchema.parse({
  localSiteId: target,
  localOrgId: orgId,
  revisionId,
  digest,
  approvalJws: "local.signature",
  counterpartyJws: "peer.signature",
  approvedBy: userId,
  createdAt: "2026-01-01T00:00:00Z",
  terms: {
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: userId,
    salt: "b".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    consideration: "paid",
    priceVersionId: userId,
    termsText: "Agreed rates",
    prices: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        perQuantity: "1000",
        amount: "9007199254740993",
      },
    ],
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: revisionId,
      sourceSiteId: source,
      targetSiteId: target,
      mode: "bilateral_attested",
      budgetDomainId: orgId,
      epoch: userId,
      unit: "credit.micro",
      budgetLimit: "99999999999999999999999999999999999999",
      maxTaskAmount: "9007199254740993",
      maxReservations: 10,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
      templates: [{ originSiteId: source, kind: "script", id: userId, revision: "1", digest }],
      resourceLimit: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 },
      termsDigest: digest,
    },
  },
});
const bill = CommercialBillSchema.parse({
  protocolVersion: 1,
  kind: "commercial-bill",
  billId,
  domainId: userId,
  agreementDigest: digest,
  priceVersionId: userId,
  reportId,
  reportDigest: digest,
  reservationId: null,
  discount: null,
  salt: "c".repeat(64),
  issuedAt: "2026-01-02T01:00:00Z",
  request: {
    protocolVersion: 1,
    kind: "delegation",
    operationId: userId,
    senderSiteId: source,
    recipientSiteId: target,
    agreementRevisionId: revisionId,
    mode: "bilateral_attested",
    budgetDomainId: orgId,
    epoch: userId,
    taskId: userId,
    attempt: 1,
    issuedAt: "2026-01-02T00:00:00Z",
    expiresAt: "2026-01-02T00:30:00Z",
    template: approval.terms.agreement.templates[0],
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    resources: approval.terms.agreement.resourceLimit,
    maxAmount: "9007199254740993",
    unit: "credit.micro",
  },
  calculation: {
    rounding: "ceil-per-line",
    lines: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        quantity: "1000",
        perQuantity: "1000",
        rateAmount: "9007199254740993",
        amount: "9007199254740993",
      },
    ],
    grossAmount: "9007199254740993",
    capReduction: "0",
    discountAmount: "0",
    dueAmount: "9007199254740993",
  },
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  billId,
  payload: bill,
  digest,
  approvalJws: "bill.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  createdAt: bill.issuedAt,
};
const settlementId = "33333333-3333-4333-8333-333333333333";
const settlement = CommercialSettlementSchema.parse({
  protocolVersion: 1,
  kind: "commercial-settlement",
  settlementId,
  domainId: userId,
  agreementRevisionId: revisionId,
  billId,
  billDigest: digest,
  sourceSiteId: source,
  targetSiteId: target,
  reservationId: null,
  terminal: null,
  unit: "credit.micro",
  reservedAmount: "9007199254740999",
  chargedAmount: "9007199254740993",
  releasedAmount: "6",
  issuedAt: bill.issuedAt,
  salt: "d".repeat(64),
});
const savedSettlement = {
  ...saved,
  settlementId,
  payload: settlement,
  appliedAt: null,
};
const base = `/api/federation/commercial-agreements/${revisionId}`;
const policyInput = {
  kind: "bill",
  outcomes: ["completed"],
  maxAmount: "9007199254740993",
  maxTotalAmount: "9007199254740999",
  maxRecords: 3,
  validUntil: "2099-01-01T00:00:00Z",
};
const policy = {
  ...policyInput,
  id: billId,
  localOrgId: orgId,
  localSiteId: target,
  agreementRevisionId: revisionId,
  agreementDigest: approval.digest,
  approvedAmount: "0",
  approvedRecords: 0,
  validFrom: "2026-01-01T00:00:00Z",
  grantedBy: userId,
  revokedAt: null,
  revokedBy: null,
};
let server: ReturnType<typeof Bun.serve>, directory: string;
let requests: {
  path: string;
  method: string;
  org: string | null;
  authorization: string | null;
  body: unknown;
}[];
let respond: (request: Request, body: unknown) => Response | Promise<Response>;
let output: ReturnType<typeof spyOn<typeof console, "log">>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kq-federation-cli-"));
  requests = [];
  output = spyOn(console, "log").mockImplementation(() => {});
  respond = (request) => {
    const url = new URL(request.url);
    if (url.pathname === base) return Response.json({ data: approval });
    if (url.pathname.endsWith("/bills"))
      return Response.json({ data: { data: [{ bill: saved, ledger: null }], hasMore: false } });
    if (url.pathname.endsWith("/bills/draft")) return Response.json({ data: bill });
    if (url.pathname.endsWith("/bills/approve")) return Response.json({ data: saved });
    if (url.pathname.endsWith("/closing-policies"))
      return Response.json({ data: request.method === "POST" ? policy : [policy] });
    return Response.json({ error: { code: "UNEXPECTED_REQUEST" } }, { status: 404 });
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = request.method === "GET" ? undefined : await request.json();
      requests.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        method: request.method,
        org: request.headers.get("X-KQ-Active-Organization"),
        authorization: request.headers.get("Authorization"),
        body,
      });
      return respond(request, body);
    },
  });
});
afterEach(async () => {
  server.stop(true);
  output.mockRestore();
  await rm(directory, { recursive: true, force: true });
});
async function run(args: string[], org = orgId, lang = "en") {
  const p = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerFederationCommand(p, () => ({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: "isolated-cli-token",
  }));
  await p.parseAsync([
    "node",
    "kq",
    "federation",
    ...(org ? ["--org", org] : []),
    "--lang",
    lang,
    ...args,
  ]);
  return output.mock.calls.map((c) => c.join(" ")).join("\n");
}
async function inputFile(value: unknown = policyInput) {
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

test("CLI financial reads pin organization and retain exact values and independent status labels", async () => {
  const text = await run(["bills", "list", revisionId, "--record", billId]);
  expect(text).toContain("9007199254740993");
  expect(text).toContain("Signatures: Locally approved");
  expect(text).toContain("Local evidence:");
  expect(
    requests.every((r) => r.org === orgId && r.authorization === "Bearer isolated-cli-token"),
  ).toBe(true);
  expect(requests[1]?.path).toBe(`${base}/bills?limit=20&offset=0&recordId=${billId}`);
  expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test("CLI grants the reviewed authority once and preserves exact amounts and finite scope", async () => {
  const text = await run(["closing", "policies", "grant", revisionId, await inputFile()]);
  expect(text).toContain("Institution authority granted");
  expect(requests.filter((r) => r.method === "POST")).toEqual([
    {
      path: `${base}/closing-policies`,
      method: "POST",
      org: orgId,
      authorization: "Bearer isolated-cli-token",
      body: policyInput,
    },
  ]);
});

test("CLI rejects malformed JSON without echoing private contents and does not grant outside contract", async () => {
  const file = join(directory, "broken.json");
  await writeFile(file, '{"secret":"private-probe" broken}');
  await expect(run(["closing", "policies", "grant", revisionId, file])).rejects.toThrow(
    "Invalid federation",
  );
  await expect(
    run([
      "closing",
      "policies",
      "grant",
      revisionId,
      await inputFile({ ...policyInput, maxAmount: "9007199254740994" }),
    ]),
  ).rejects.toThrow("Invalid federation");
  expect(requests.some((r) => r.method === "POST")).toBe(false);
  expect(output.mock.calls).toHaveLength(0);
});

test("CLI unknown grant response is not retried and original authority can be queried", async () => {
  const original = respond;
  respond = (request, body) =>
    request.method === "POST" ? new Response('{"data":', { status: 200 }) : original(request, body);
  await expect(
    run(["closing", "policies", "grant", revisionId, await inputFile()]),
  ).rejects.toThrow("Write outcome unconfirmed");
  const text = await run(["closing", "policies", "list", revisionId]);
  expect(text).toContain(policy.id);
  expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

test("CLI refuses redirects on reads and writes without calling the destination", async () => {
  respond = () => Response.redirect(`http://127.0.0.1:${server.port}/unintended`, 307);
  await expect(run(["contracts", "show", revisionId])).rejects.toThrow();
  expect(requests).toHaveLength(1);
  respond = (request) =>
    new URL(request.url).pathname === base
      ? Response.json({ data: approval })
      : Response.redirect(`http://127.0.0.1:${server.port}/unintended`, 307);
  await expect(
    run(["closing", "policies", "grant", revisionId, await inputFile()]),
  ).rejects.toThrow("Write outcome unconfirmed");
  expect(requests.some((r) => r.path === "/unintended")).toBe(false);
});

test("CLI rejects foreign contract or returned policy before printing private records", async () => {
  respond = () => Response.json({ data: { ...approval, localOrgId: source } });
  await expect(run(["contracts", "show", revisionId, "--json"])).rejects.toThrow(
    "organization or contract",
  );
  expect(output.mock.calls).toHaveLength(0);
  respond = (request) =>
    Response.json({
      data: new URL(request.url).pathname === base ? approval : [{ ...policy, localOrgId: source }],
    });
  await expect(run(["closing", "policies", "list", revisionId, "--json"])).rejects.toThrow(
    "scope mismatch",
  );
  expect(output.mock.calls).toHaveLength(0);
});

test("CLI preserves server independent authority failures without treating them as success", async () => {
  respond = (request) =>
    new URL(request.url).pathname === base
      ? Response.json({ data: approval })
      : Response.json({ error: { code: "POLICY_DENIED" } }, { status: 403 });
  await expect(
    run(["closing", "policies", "grant", revisionId, await inputFile()]),
  ).rejects.toThrow("HTTP 403 POLICY_DENIED");
  expect(output.mock.calls).toHaveLength(0);
});

test("CLI draft only exports to a new owner-only file and approval sends the unchanged original", async () => {
  const file = join(directory, "bill.json");
  await run(["bills", "draft", revisionId, reportId, file, "--id", billId]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(bill);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(requests.filter((r) => r.path.endsWith("/approve"))).toHaveLength(0);
  await expect(run(["contracts", "export", revisionId, file])).rejects.toThrow("EEXIST");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(bill);
  await run(["bills", "approve", revisionId, file]);
  expect(requests.find((r) => r.path.endsWith("/bills/approve"))?.body).toEqual(bill);
});

test("CLI requires an explicit pinned organization and rejects path injection", async () => {
  await expect(run(["bills", "list", revisionId], "")).rejects.toThrow("--org");
  await expect(run(["contracts", "show", "../../admin"])).rejects.toThrow("Invalid federation");
  expect(requests).toHaveLength(0);
});

test("CLI organization selection is an explicit authenticated PUT, not a mutation header", async () => {
  respond = (_request, body) =>
    Response.json({ activeOrganizationId: (body as { organizationId: string }).organizationId });
  await run(["use", target], "");
  expect(requests[0]).toMatchObject({
    path: "/api/me/active-organization",
    method: "PUT",
    org: null,
    body: { organizationId: target },
  });
});

test("CLI Chinese output and JSON retain real policy state without treating zero amount as exhausted", async () => {
  respond = (request) =>
    Response.json({
      data:
        new URL(request.url).pathname === base
          ? approval
          : [{ ...policy, maxAmount: "0", maxTotalAmount: "0" }],
    });
  const text = await run(["closing", "policies", "list", revisionId], orgId, "zh");
  expect(text).toContain("有效");
  output.mockClear();
  const json = await run(["closing", "policies", "list", revisionId, "--json"]);
  expect(JSON.parse(json)[0].maxTotalAmount).toBe("0");
});

test("CLI does not transmit an oversized authority input", async () => {
  const file = join(directory, "large.json");
  await writeFile(file, " ".repeat(600001));
  await expect(run(["closing", "policies", "grant", revisionId, file])).rejects.toThrow(
    "exceeds 600000",
  );
  expect(requests).toHaveLength(0);
});

for (const mode of ["bilateral_direct", "bilateral_attested", "ledger_coordinated"] as const) {
  test(`CLI ${mode} settlement distinguishes signatures, accounting and evidence`, async () => {
    respond = (request) =>
      Response.json({
        data:
          new URL(request.url).pathname === base
            ? {
                ...approval,
                terms: { ...approval.terms, agreement: { ...approval.terms.agreement, mode } },
              }
            : {
                data: [
                  {
                    settlement: {
                      ...savedSettlement,
                      counterpartyJws: "peer.signature",
                      appliedAt: mode === "ledger_coordinated" ? null : bill.issuedAt,
                    },
                    ledger:
                      mode === "bilateral_direct"
                        ? null
                        : { id: settlementId, state: "pending", lastError: null },
                  },
                ],
                hasMore: false,
              },
      });
    const text = await run(["settlements", "list", revisionId, "--record", settlementId]);
    expect(text).toContain("Reserved: 9007199254740999");
    expect(text).toContain("Charged: 9007199254740993");
    expect(text).toContain("Returned: 6");
    expect(text).toContain("Signatures: Both signed");
    expect(text).toContain(
      `Local accounting: ${mode === "ledger_coordinated" ? "Not applied" : "Applied"}`,
    );
    expect(text).toContain(
      `Local evidence: ${mode === "bilateral_direct" ? "Not required" : "Pending"}`,
    );
  });
}

test("CLI revokes original authority and validates retry acknowledgments without replay", async () => {
  const original = respond;
  respond = (request, body) =>
    new URL(request.url).pathname.endsWith("/revoke")
      ? Response.json({ data: { ...policy, revokedAt: bill.issuedAt, revokedBy: userId } })
      : new URL(request.url).pathname.endsWith("/retry")
        ? Response.json({ success: true })
        : original(request, body);
  expect(await run(["closing", "policies", "revoke", revisionId, policy.id])).toContain(
    "Institution authority revoked",
  );
  expect(await run(["closing", "tasks", "retry", revisionId, "bill", reportId])).toContain(
    "Original processing requested",
  );
  const valid = respond;
  respond = (request, body) =>
    new URL(request.url).pathname.endsWith("/retry")
      ? Response.json({ success: false })
      : valid(request, body);
  output.mockClear();
  await expect(
    run(["closing", "tasks", "retry", revisionId, "settlement", billId]),
  ).rejects.toThrow("Write outcome unconfirmed");
  expect(output.mock.calls).toHaveLength(0);
  expect(requests.filter((r) => r.path.endsWith(`/settlement/${billId}/retry`))).toHaveLength(1);
});

test("CLI settlement draft and approval preserve the original and reject a changed response identity", async () => {
  const original = respond;
  respond = (request, body) =>
    new URL(request.url).pathname.endsWith("/settlements/draft")
      ? Response.json({ data: settlement })
      : new URL(request.url).pathname.endsWith("/settlements/approve")
        ? Response.json({ data: savedSettlement })
        : original(request, body);
  const file = join(directory, "settlement.json");
  await run(["settlements", "draft", revisionId, billId, file, "--id", settlementId]);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settlement);
  await run(["settlements", "approve", revisionId, file]);
  expect(requests.find((r) => r.path.endsWith("/settlements/approve"))?.body).toEqual(settlement);
  const valid = respond;
  respond = (request, body) =>
    new URL(request.url).pathname.endsWith("/settlements/approve")
      ? Response.json({ data: { ...savedSettlement, settlementId: reportId } })
      : valid(request, body);
  output.mockClear();
  await expect(run(["settlements", "approve", revisionId, file])).rejects.toThrow(
    "record identity mismatch",
  );
  expect(output.mock.calls).toHaveLength(0);
});

test("CLI attaches only the original counterpart signature and rejects mismatched row identity", async () => {
  const file = join(directory, "approval.jws");
  await writeFile(file, "counterpart.original.signature\n", { mode: 0o600 });
  for (const [kind, id, row] of [
    ["bills", billId, saved],
    ["settlements", settlementId, savedSettlement],
  ] as const) {
    respond = (request) =>
      Response.json({
        data:
          new URL(request.url).pathname === base
            ? approval
            : { ...row, counterpartyJws: "counterpart.original.signature" },
      });
    await run([kind, "attach", revisionId, id, file]);
    expect(requests.at(-1)).toMatchObject({
      path: `${base}/${kind}/${id}/counterparty`,
      body: { approvalJws: "counterpart.original.signature" },
    });
    respond = (request) =>
      Response.json({
        data:
          new URL(request.url).pathname === base
            ? approval
            : { ...row, billId: reportId, counterpartyJws: "counterpart.original.signature" },
      });
    output.mockClear();
    await expect(run([kind, "attach", revisionId, id, file])).rejects.toThrow(
      "record identity mismatch",
    );
    expect(output.mock.calls).toHaveLength(0);
  }
});

test("CLI policy pagination exposes single-record limits and permitted outcomes", async () => {
  const text = await run([
    "closing",
    "policies",
    "list",
    revisionId,
    "--limit",
    "1",
    "--offset",
    "2",
  ]);
  expect(requests.at(-1)?.path).toBe(`${base}/closing-policies?limit=1&offset=2`);
  expect(text).toContain("Per-record limit: 9007199254740993");
  expect(text).toContain("Allowed outcomes: completed");
});
