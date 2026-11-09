import { afterEach, expect, test } from "bun:test";
import {
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { Client, credentials } from "@grpc/grpc-js";
import { connect, signers } from "@hyperledger/fabric-gateway";
import { peer, gateway as proto } from "@hyperledger/fabric-protos";
import {
  type CaseProposal,
  CaseProposalSchema,
  CasePublicationSchema,
  CaseRevocationSchema,
  CaseSigningKindSchema,
  type FabricCaseTrust,
  FabricCaseTrustSchema,
  fabricCaseCollections,
} from "@kuintessence/shared/federation/case-ledger";
import { CommercialDisclosureSchema } from "@kuintessence/shared/federation/disclosure";
import { CommercialDisclosurePolicySchema } from "@kuintessence/shared/federation/disclosure-authorization";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import { CaseLedger } from "../contracts/fabric/commercial/src/case-contract";
import { CaseAdapterConfigSchema, FabricCaseAdapter } from "../packages/fabric-adapter/src/case";
import { createCaseHttpServer } from "../packages/fabric-adapter/src/case-runtime";

const pairs = await Promise.all(
  Array.from({ length: 4 }, () => generateKeyPair("RS256", { extractable: true })),
);
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const digest = (jws: string) => {
  const value = jws.split(".")[1];
  if (!value) throw new Error("Missing signed payload");
  return `sha256:${createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex")}`;
};
class Memory {
  state = new Map<string, Uint8Array>();
  privateState = new Map<string, Uint8Array>();
  hashes = new Map<string, Uint8Array>();
  policies = new Map<string, Uint8Array>();
  reads = new Set<string>();
  transient = new Map<string, Uint8Array>();
  fcn = "Init";
  params: string[] = [];
  now = new Date();
  getFunctionAndParameters = () => ({ fcn: this.fcn, params: this.params });
  getDateTimestamp = () => this.now;
  getTransient = () => this.transient;
  createCompositeKey = (kind: string, values: string[]) => JSON.stringify([kind, ...values]);
  getState = async (key: string) => {
    this.reads.add(key);
    return this.state.get(key) ?? new Uint8Array();
  };
  putState = async (key: string, value: Uint8Array) => {
    this.state.set(key, value);
  };
  setStateValidationParameter = async (key: string, value: Uint8Array) => {
    this.policies.set(key, value);
  };
  getPrivateData = async (collection: string, key: string) => {
    this.reads.add(`${collection}:${key}`);
    return this.privateState.get(`${collection}:${key}`) ?? new Uint8Array();
  };
  getPrivateDataHash = async (collection: string, key: string) =>
    this.hashes.get(`${collection}:${key}`) ?? new Uint8Array();
  putPrivateData = async (collection: string, key: string, value: Uint8Array) => {
    this.privateState.set(`${collection}:${key}`, value);
    this.hashes.set(`${collection}:${key}`, createHash("sha256").update(value).digest());
  };
}
async function fixture() {
  const now = new Date(),
    validFrom = new Date(now.getTime() - 60000).toISOString(),
    validUntil = new Date(now.getTime() + 3600000).toISOString();
  const keys: FederationSigningKey[] = pairs.map((pair, index) => ({
    siteId: randomUUID(),
    keyId: `key-${index}`,
    privateKey: pair.privateKey,
  }));
  const [a, b, r, d] = keys;
  if (!a || !b || !r || !d) throw new Error("Missing signers");
  const trust = FabricCaseTrustSchema.parse({
    version: 1,
    generationId: randomUUID(),
    organizations: await Promise.all(
      keys.map(async (key, index) => {
        const pair = pairs[index];
        if (!pair) throw new Error("Missing keypair");
        return {
          siteId: key.siteId,
          mspId: ["AMSP", "BMSP", "RMSP", "DMSP"][index],
          keys: [
            {
              keyId: key.keyId,
              publicKeyPem: await exportSPKI(pair.publicKey),
              validFrom,
              validUntil,
            },
          ],
        };
      }),
    ),
    domains: [
      {
        domainId: randomUUID(),
        commercialDomainId: randomUUID(),
        sourceSiteId: a.siteId,
        targetSiteId: b.siteId,
        recipientSiteId: r.siteId,
        collection: "case_ABR_v1",
      },
    ],
    keyPurposes: keys.map((key) => ({
      siteId: key.siteId,
      keyId: key.keyId,
      kinds: [...CaseSigningKindSchema.options],
    })),
  });
  const domain = trust.domains[0];
  if (!domain) throw new Error("Missing domain");
  const sign = async <T>(schema: z.ZodType<T>, value: T) => ({
    sourceSiteId: a.siteId,
    targetSiteId: b.siteId,
    sourceJws: await signFederationMessage(schema, value, a),
    targetJws: await signFederationMessage(schema, value, b),
  });
  const policy = CommercialDisclosurePolicySchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure-policy",
    policyId: randomUUID(),
    domainId: domain.commercialDomainId,
    agreementRevisionId: randomUUID(),
    agreementDigest: `sha256:${"a".repeat(64)}`,
    sourceSiteId: a.siteId,
    targetSiteId: b.siteId,
    recipientSiteId: r.siteId,
    disclosures: [{ recordType: "bill", fields: ["dueAmount"] }],
    issuedAt: validFrom,
    validFrom,
    validUntil,
    salt: randomBytes(32).toString("hex"),
  });
  const policyPair = await sign(CommercialDisclosurePolicySchema, policy);
  const value = CommercialDisclosureSchema.parse({
    protocolVersion: 1,
    kind: "commercial-disclosure",
    grant: {
      protocolVersion: 1,
      kind: "commercial-disclosure-grant",
      grantId: randomUUID(),
      caseId: randomUUID(),
      policyId: policy.policyId,
      policyDigest: digest(policyPair.sourceJws),
      domainId: policy.domainId,
      agreementRevisionId: policy.agreementRevisionId,
      sourceSiteId: a.siteId,
      targetSiteId: b.siteId,
      recipientSiteId: r.siteId,
      recordType: "bill",
      recordId: randomUUID(),
      recordDigest: `sha256:${"b".repeat(64)}`,
      fields: ["dueAmount"],
      validFrom,
      validUntil,
      salt: randomBytes(32).toString("hex"),
    },
    evidence: { recordType: "bill", values: { dueAmount: "9007199254740993" } },
  });
  const disclosure = await sign(CommercialDisclosureSchema, value);
  const publication = CasePublicationSchema.parse({
    protocolVersion: 1,
    kind: "case-evidence-publication",
    publicationId: randomUUID(),
    caseDomainId: domain.domainId,
    scope: {
      grantId: value.grant.grantId,
      disclosureDigest: digest(disclosure.sourceJws),
      caseId: value.grant.caseId,
      policyId: policy.policyId,
      policyDigest: value.grant.policyDigest,
      domainId: policy.domainId,
      agreementRevisionId: policy.agreementRevisionId,
      agreementDigest: policy.agreementDigest,
      sourceSiteId: a.siteId,
      targetSiteId: b.siteId,
      evidenceRecipientSiteId: r.siteId,
    },
    issuedAt: now.toISOString(),
    validUntil,
    salt: randomBytes(32).toString("hex"),
  });
  const signed = async (payload = publication) => {
    const pair = await sign(CasePublicationSchema, payload);
    return CaseProposalSchema.options[0].parse({
      operation: "record-case-evidence",
      domainId: domain.domainId,
      recordId: payload.publicationId,
      digest: digest(pair.sourceJws),
      envelope: { publication: pair, evidence: { policy: policyPair, disclosure } },
    });
  };
  const input = await signed();
  const revoke = async (signer = a) => {
    const payload = CaseRevocationSchema.parse({
      protocolVersion: 1,
      kind: "case-publication-revocation",
      revocationId: randomUUID(),
      caseDomainId: domain.domainId,
      publicationId: publication.publicationId,
      publicationDigest: input.digest,
      issuerSiteId: signer.siteId,
      issuedAt: now.toISOString(),
      salt: randomBytes(32).toString("hex"),
    });
    const jws = await signFederationMessage(CaseRevocationSchema, payload, signer);
    return CaseProposalSchema.options[1].parse({
      operation: "revoke-case-publication",
      domainId: domain.domainId,
      recordId: payload.revocationId,
      digest: digest(jws),
      envelope: { issuerSiteId: signer.siteId, jws },
    });
  };
  const identity = (index = 0, role = "case") => ({
    getMSPID: () => trust.organizations[index]?.mspId ?? "",
    getAttributeValue: (name: string) =>
      name === "kq.federation.site"
        ? (keys[index]?.siteId ?? null)
        : name === "kq.federation.role"
          ? role
          : null,
  });
  const memory = new Memory();
  memory.now = now;
  const ledger = new CaseLedger(trust);
  await ledger.initialize(memory, identity(0, "trust-admin"));
  const invoke = (value: CaseProposal, index = 0) => {
    memory.fcn =
      value.operation === "record-case-evidence" ? "RecordCaseEvidence" : "RevokeCasePublication";
    memory.params = [value.domainId, value.recordId];
    memory.transient = new Map([["case", Buffer.from(JSON.stringify(value))]]);
    return ledger.invoke(memory, identity(index));
  };
  return {
    trust,
    domain,
    keys,
    a,
    b,
    r,
    d,
    sign,
    publication,
    signed,
    input,
    revoke,
    memory,
    ledger,
    identity,
    invoke,
  };
}

test("case PDC has exactly A/B/R native membership and all-three endorsement; invalid domain mappings fail", async () => {
  const f = await fixture(),
    collections = fabricCaseCollections(f.trust);
  expect(collections).toEqual([
    {
      name: "case_ABR_v1",
      policy: "OR('AMSP.member','BMSP.member','RMSP.member')",
      requiredPeerCount: 2,
      maxPeerCount: 2,
      blockToLive: 0,
      memberOnlyRead: true,
      memberOnlyWrite: true,
      endorsementPolicy: { signaturePolicy: "AND('AMSP.peer','BMSP.peer','RMSP.peer')" },
    },
  ]);
  for (const domain of [
    { ...f.domain, recipientSiteId: f.a.siteId },
    { ...f.domain, collection: "commercial_AB" },
    { ...f.domain, sourceSiteId: randomUUID() },
    { ...f.domain, domainId: f.domain.commercialDomainId },
  ])
    expect(FabricCaseTrustSchema.safeParse({ ...f.trust, domains: [domain] }).success).toBe(false);
  expect(FabricCaseTrustSchema.safeParse({ ...f.trust, keyPurposes: [] }).success).toBe(false);
});
test("case ledger stores only consented projection in its PDC and immutable replay has no public evidence writes", async () => {
  const f = await fixture(),
    before = structuredClone(f.memory.state);
  const receipt = await f.invoke(f.input, 2),
    original = structuredClone(f.memory.privateState);
  expect(JSON.parse(receipt.toString())).toEqual({
    recordId: f.input.recordId,
    digest: f.input.digest,
  });
  expect(await f.invoke(f.input)).toEqual(receipt);
  expect(f.memory.privateState).toEqual(original);
  expect(f.memory.state).toEqual(before);
  expect(f.memory.privateState.size).toBe(1);
  expect([...f.memory.privateState.keys()].every((key) => key.startsWith("case_ABR_v1:"))).toBe(
    true,
  );
  const [stored] = f.memory.privateState.values();
  if (!stored) throw new Error("Missing stored publication");
  expect(
    z.object({ input: CaseProposalSchema }).parse(JSON.parse(Buffer.from(stored).toString())).input,
  ).toEqual(f.input);
  f.memory.fcn = "GetCaseReceipt";
  f.memory.params = [f.domain.domainId, "case-evidence", f.input.recordId];
  f.memory.transient.clear();
  expect(JSON.parse((await f.ledger.invoke(f.memory, f.identity(2))).toString())).toEqual({
    receipt: { recordId: f.input.recordId, digest: f.input.digest },
  });
  await expect(f.ledger.invoke(f.memory, f.identity(3))).rejects.toThrow("POLICY_DENIED");
  await expect(f.ledger.invoke(f.memory, f.identity(2, "trust-admin"))).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});
test("read consent and R signature cannot substitute for independent A/B ledger publication consent", async () => {
  const f = await fixture();
  for (const targetJws of [
    f.input.envelope.publication.sourceJws,
    f.input.envelope.evidence.disclosure.targetJws,
    await signFederationMessage(CasePublicationSchema, f.publication, f.r),
  ])
    await expect(
      f.invoke({
        ...f.input,
        envelope: {
          ...f.input.envelope,
          publication: { ...f.input.envelope.publication, targetJws },
        },
      }),
    ).rejects.toThrow();
  expect(f.memory.privateState.size).toBe(0);
});
test("all six original signatures and exact publication scope are verified before storing fields", async () => {
  const f = await fixture();
  for (const name of ["publication", "policy", "disclosure"] as const)
    for (const side of ["sourceJws", "targetJws"] as const) {
      const value = structuredClone(f.input),
        pair = name === "publication" ? value.envelope.publication : value.envelope.evidence[name];
      pair[side] = `${pair[side].slice(0, -5)}wrong`;
      await expect(f.invoke(value)).rejects.toThrow();
    }
  for (const change of [
    { recordId: randomUUID() },
    { digest: `sha256:${"f".repeat(64)}` },
    { domainId: randomUUID() },
  ])
    await expect(f.invoke({ ...f.input, ...change })).rejects.toThrow();
  await expect(
    f.invoke(
      await f.signed({ ...f.publication, scope: { ...f.publication.scope, caseId: randomUUID() } }),
    ),
  ).rejects.toThrow();
  expect(f.memory.privateState.size).toBe(0);
});
test("publication cannot outlive disclosure or be used after expiry or key revocation", async () => {
  const f = await fixture();
  await expect(
    f.invoke(
      await f.signed({
        ...f.publication,
        validUntil: new Date(Date.parse(f.publication.validUntil) + 1).toISOString(),
      }),
    ),
  ).rejects.toThrow();
  f.memory.now = new Date(Date.parse(f.publication.validUntil));
  await expect(f.invoke(f.input)).rejects.toThrow();
  f.memory.now = new Date(f.publication.issuedAt);
  f.memory.fcn = "RevokeKey";
  f.memory.params = [f.b.siteId, f.b.keyId];
  f.memory.transient.clear();
  await f.ledger.invoke(f.memory, f.identity(1, "trust-admin"));
  await expect(f.invoke(f.input)).rejects.toThrow("UNTRUSTED_IDENTITY");
  expect(f.memory.privateState.size).toBe(0);
});
for (const member of ["a", "b"] as const)
  test(`case publication withdrawal by ${member} prevents first storage and replay while retaining historical originals`, async () => {
    const f = await fixture(),
      withdrawal = await f.revoke(f[member]);
    if (member === "a") await f.invoke(f.input);
    const old = new Map(f.memory.privateState);
    await f.invoke(withdrawal);
    const snapshot = structuredClone(f.memory.privateState);
    await f.invoke(withdrawal);
    expect(f.memory.privateState).toEqual(snapshot);
    await expect(f.invoke(f.input)).rejects.toThrow("POLICY_DENIED");
    for (const [key, value] of old) expect(f.memory.privateState.get(key)).toEqual(value);
    expect([...f.memory.reads].some((key) => key.includes("case-withdrawn"))).toBe(true);
  });
test("recipient cannot revoke A/B publication and same publication ID cannot replace an approved original", async () => {
  const f = await fixture();
  await expect(f.invoke(await f.revoke(f.r), 2)).rejects.toThrow("POLICY_DENIED");
  await f.invoke(f.input);
  const prior = structuredClone(f.memory.privateState);
  await expect(
    f.invoke(await f.signed({ ...f.publication, salt: randomBytes(32).toString("hex") })),
  ).rejects.toThrow("OPERATION_CONFLICT");
  expect(f.memory.privateState).toEqual(prior);
});
test("missing or corrupt PDC bytes cannot be mistaken for an unused publication ID", async () => {
  const f = await fixture();
  await f.invoke(f.input);
  const [key] = f.memory.privateState.keys();
  if (!key) throw new Error("Missing original");
  f.memory.privateState.delete(key);
  await expect(f.invoke(f.input)).rejects.toThrow("DATA_WAITING");
  f.memory.privateState.set(key, Buffer.from("corrupt"));
  await expect(f.invoke(f.input)).rejects.toThrow("DATA_WAITING");
});

function adapter(
  f: Awaited<ReturnType<typeof fixture>>,
  siteId = f.r.siteId,
  trust: FabricCaseTrust = f.trust,
) {
  const config = CaseAdapterConfigSchema.parse({
    siteId,
    channel: "cooperation",
    chaincode: "kq-cases",
    trust,
  });
  const client = new Client("127.0.0.1:1", credentials.createInsecure());
  const identity = {
    mspId: trust.organizations.find((org) => org.siteId === siteId)?.mspId ?? "",
    credentials: Buffer.from("sdk-test-case-identity"),
  };
  const signer = signers.newPrivateKeySigner(
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  );
  const gateway = connect({ client, identity, signer }),
    recoveryKey = randomBytes(32);
  cleanup.push(() => {
    gateway.close();
    client.close();
  });
  return {
    config,
    identity,
    recoveryKey,
    gateway,
    signer,
    adapter: new FabricCaseAdapter(config, gateway, identity, signer, recoveryKey),
  };
}
test("case Adapter creates encrypted recoverable SDK proposal with no field values in public args and no outsider endorsements", async () => {
  const f = await fixture(),
    sdk = adapter(f);
  for (const input of [f.input, await f.revoke()]) {
    const prepared = await sdk.adapter.prepare(input),
      bytes = Buffer.from(prepared.recovery, "base64");
    const cipher = createDecipheriv("aes-256-gcm", sdk.recoveryKey, bytes.subarray(0, 12));
    cipher.setAAD(
      createHash("sha256")
        .update(JSON.stringify({ purpose: "kq-case-v1", config: sdk.config }))
        .update(sdk.identity.credentials)
        .digest(),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    const stored = z
      .object({ batchId: z.uuid(), digest: z.string(), message: z.object({ bytes: z.string() }) })
      .parse(
        JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()),
      );
    expect(stored.batchId).toBe(input.recordId);
    expect(stored.digest).toBe(input.digest);
    const proposal = proto.ProposedTransaction.deserializeBinary(
      Buffer.from(stored.message.bytes, "base64"),
    );
    expect(proposal.getEndorsingOrganizationsList()).toEqual(["AMSP", "BMSP", "RMSP"]);
    const signed = proposal.getProposal();
    if (!signed) throw new Error("Missing SDK proposal");
    const payload = peer.ChaincodeProposalPayload.deserializeBinary(
      peer.Proposal.deserializeBinary(signed.getProposalBytes_asU8()).getPayload_asU8(),
    );
    expect(Buffer.from(payload.getTransientmapMap().get("case") ?? []).toString()).toBe(
      JSON.stringify(input),
    );
    const args = peer.ChaincodeInvocationSpec.deserializeBinary(payload.getInput_asU8())
      .getChaincodeSpec()
      ?.getInput()
      ?.getArgsList_asU8()
      .map((value) => Buffer.from(value).toString());
    expect(args).toEqual([
      input.operation === "record-case-evidence" ? "RecordCaseEvidence" : "RevokeCasePublication",
      input.domainId,
      input.recordId,
    ]);
    await expect(adapter(f).adapter.advance(prepared.recovery)).rejects.toThrow("INVALID_RECOVERY");
    expect(bytes.includes(Buffer.from("9007199254740993"))).toBe(false);
  }
});
test("case Adapter rejects wrong identity, changed references and absent publication purpose before Gateway access", async () => {
  const f = await fixture(),
    sdk = adapter(f);
  await expect(
    sdk.adapter.prepare({ ...f.input, digest: `sha256:${"0".repeat(64)}` }),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await expect(adapter(f, f.d.siteId).adapter.prepare(f.input)).rejects.toThrow("POLICY_DENIED");
  const trust = structuredClone(f.trust);
  for (const purpose of trust.keyPurposes) purpose.kinds = ["commercial-disclosure"];
  await expect(adapter(f, f.a.siteId, trust).adapter.prepare(f.input)).rejects.toThrow(
    "UNTRUSTED_IDENTITY",
  );
});
test("case runtime accepts only the private case paths and hides raw transport errors", async () => {
  const server = createCaseHttpServer({
    prepare: async () => {
      throw new Error("private amount 9007199254740993");
    },
    advance: async () => {
      throw new Error("unused");
    },
    receipt: async () => ({ receipt: null }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const base = `http://127.0.0.1:${address.port}`,
      f = await fixture();
    const response = await fetch(`${base}/v1/case/proposal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.input),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ code: "LEDGER_UNAVAILABLE" });
    expect((await fetch(`${base}/v1/commercial/proposal`, { method: "POST" })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
