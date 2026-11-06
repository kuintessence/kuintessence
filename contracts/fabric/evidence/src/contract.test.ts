import { beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type FabricEvidenceTrust,
  type FederationEvidenceBatch,
  FederationEvidenceBatchSchema,
  fabricEvidenceCollections,
} from "@kuintessence/shared/federation/ledger";
import {
  type FederationSigningKey,
  signFederationMessage,
} from "@kuintessence/shared/federation/signatures";
import { exportSPKI, generateKeyPair } from "jose";
import { EvidenceLedger } from "./contract";

const sites = [randomUUID(), randomUUID(), randomUUID()] as const;
const domainId = randomUUID();
let trust: FabricEvidenceTrust;
const keys: FederationSigningKey[] = [];

beforeAll(async () => {
  const organizations: FabricEvidenceTrust["organizations"] = [];
  for (const [i, siteId] of sites.entries()) {
    const key = await generateKeyPair("RS256", { extractable: true });
    keys.push({ siteId, keyId: "batch-1", privateKey: key.privateKey });
    organizations.push({
      siteId,
      mspId: `${String.fromCharCode(65 + i)}MSP`,
      keys: [
        {
          keyId: "batch-1",
          publicKeyPem: await exportSPKI(key.publicKey),
          validFrom: "2026-01-01T00:00:00Z",
          validUntil: "2030-01-01T00:00:00Z",
        },
      ],
    });
  }
  trust = {
    version: 1,
    generationId: randomUUID(),
    organizations,
    domains: [{ domainId, collection: "evidence_AB_v1", siteIds: [sites[0], sites[1]] }],
  };
});

function identity(index = 0, role = "attestor") {
  return {
    getMSPID: () => `${String.fromCharCode(65 + index)}MSP`,
    getAttributeValue: (name: string) =>
      name === "kq.federation.site"
        ? (sites[index] ?? null)
        : name === "kq.federation.role"
          ? role
          : null,
  };
}

class MemoryLedger {
  state = new Map<string, Uint8Array>();
  policies = new Map<string, Uint8Array>();
  privateState = new Map<string, Uint8Array>();
  privateHashes = new Map<string, Uint8Array>();
  transient = new Map<string, Uint8Array>();
  fcn = "Init";
  params: string[] = [];
  timestamp = new Date("2027-01-01T00:00:00Z");
  getFunctionAndParameters = () => ({ fcn: this.fcn, params: this.params });
  getDateTimestamp = () => this.timestamp;
  getTransient = () => this.transient;
  createCompositeKey = (name: string, parts: string[]) => JSON.stringify([name, ...parts]);
  getState = async (key: string) => this.state.get(key) ?? new Uint8Array();
  putState = async (key: string, value: Uint8Array) => {
    this.state.set(key, value);
  };
  setStateValidationParameter = async (key: string, value: Uint8Array) => {
    this.policies.set(key, value);
  };
  getPrivateData = async (collection: string, key: string) =>
    this.privateState.get(`${collection}:${key}`) ?? new Uint8Array();
  getPrivateDataHash = async (collection: string, key: string) =>
    this.privateHashes.get(`${collection}:${key}`) ?? new Uint8Array();
  putPrivateData = async (collection: string, key: string, value: Uint8Array) => {
    this.privateState.set(`${collection}:${key}`, value);
    this.privateHashes.set(`${collection}:${key}`, createHash("sha256").update(value).digest());
  };
}

function batch(overrides: Partial<FederationEvidenceBatch> = {}): FederationEvidenceBatch {
  return FederationEvidenceBatchSchema.parse({
    protocolVersion: 1,
    kind: "evidence-batch",
    batchId: randomUUID(),
    domainId,
    agreementRevisionId: randomUUID(),
    epoch: randomUUID(),
    issuerSiteId: sites[0],
    counterpartySiteId: sites[1],
    confirmation: "unilateral",
    salt: randomBytes(32).toString("hex"),
    createdAt: "2026-12-31T00:00:00Z",
    records: [
      {
        evidenceId: randomUUID(),
        sequence: "1",
        kind: "acceptance",
        digest: `sha256:${"ab".repeat(32)}`,
      },
    ],
    ...overrides,
  });
}

async function envelope(value: FederationEvidenceBatch, both = false) {
  const first = keys[0];
  const second = keys[1];
  if (!first || !second) throw new Error("Missing fixture keys");
  return {
    issuerJws: await signFederationMessage(FederationEvidenceBatchSchema, value, first),
    ...(both
      ? {
          counterpartyJws: await signFederationMessage(
            FederationEvidenceBatchSchema,
            value,
            second,
          ),
        }
      : {}),
  };
}

async function setup(value = batch(), both = false) {
  const ledger = new EvidenceLedger(trust);
  const stub = new MemoryLedger();
  await ledger.initialize(stub, identity(0, "trust-admin"));
  stub.fcn = "AnchorBatch";
  stub.params = [domainId, value.batchId];
  const signed = await envelope(value, both);
  stub.transient.set("evidence", Buffer.from(JSON.stringify(signed)));
  return { ledger, stub, value, signed };
}

test("public receipts contain only random batch ID and salted digest; signed contents stay in PDC", async () => {
  const { ledger, stub, value, signed } = await setup();
  const receipt = await ledger.invoke(stub, identity());
  expect(Object.keys(JSON.parse(receipt.toString())).sort()).toEqual(["batchId", "digest"]);
  const publicData = [...stub.state.values()].map((v) => Buffer.from(v).toString()).join("");
  for (const sensitive of [signed.issuerJws, value.agreementRevisionId, value.epoch, value.salt])
    expect(publicData).not.toContain(sensitive);
  expect([...stub.privateState.keys()].every((k) => k.startsWith("evidence_AB_v1:"))).toBe(true);
  const before = stub.privateState.size;
  expect(await ledger.invoke(stub, identity())).toEqual(receipt);
  expect(stub.privateState.size).toBe(before);
  stub.fcn = "GetAnchor";
  stub.transient.clear();
  expect(await ledger.invoke(stub, identity(1))).toEqual(receipt);
  await expect(ledger.invoke(stub, identity(2))).rejects.toThrow("POLICY_DENIED");
});

test("batch content cannot change under the same ID and evidence cannot be duplicated under another ID", async () => {
  const { ledger, stub, value } = await setup();
  await ledger.invoke(stub, identity());
  const changed = await envelope({ ...value, salt: randomBytes(32).toString("hex") });
  stub.transient.set("evidence", Buffer.from(JSON.stringify(changed)));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("OPERATION_CONFLICT");
  const duplicate = batch({ records: value.records.map((r) => ({ ...r, sequence: "2" })) });
  stub.params = [domainId, duplicate.batchId];
  stub.transient.set("evidence", Buffer.from(JSON.stringify(await envelope(duplicate))));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("OPERATION_CONFLICT");
});

test("continuous batches advance one issuer stream; gaps and out-of-order submissions are rejected", async () => {
  const { ledger, stub } = await setup();
  await ledger.invoke(stub, identity());
  const next = batch();
  next.records = next.records.map((r) => ({ ...r, sequence: "3" }));
  stub.params = [domainId, next.batchId];
  stub.transient.set("evidence", Buffer.from(JSON.stringify(await envelope(next))));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("OPERATION_CONFLICT");
  next.records = next.records.map((r) => ({ ...r, sequence: "2" }));
  stub.transient.set("evidence", Buffer.from(JSON.stringify(await envelope(next))));
  expect(JSON.parse((await ledger.invoke(stub, identity())).toString()).batchId).toBe(next.batchId);
});

test("bilateral confirmation needs both business signatures, not merely two peer endorsements", async () => {
  const { ledger, stub, value } = await setup(batch({ confirmation: "bilateral" }));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("UNTRUSTED_IDENTITY");
  const signed = await envelope(value, true);
  stub.transient.set("evidence", Buffer.from(JSON.stringify(signed)));
  expect((await ledger.invoke(stub, identity())).length).toBeGreaterThan(0);
  const other = await envelope(batch({ confirmation: "bilateral" }), true);
  stub.transient.set(
    "evidence",
    Buffer.from(JSON.stringify({ ...signed, counterpartyJws: other.counterpartyJws })),
  );
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("OPERATION_CONFLICT");
});

test("only the owning institution trust administrator can revoke a business key", async () => {
  const { ledger, stub, value } = await setup();
  stub.fcn = "RevokeKey";
  stub.params = [sites[0], "batch-1"];
  const evidence = stub.transient.get("evidence");
  stub.transient.clear();
  await expect(ledger.invoke(stub, identity(1, "trust-admin"))).rejects.toThrow("POLICY_DENIED");
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("UNTRUSTED_IDENTITY");
  await ledger.invoke(stub, identity(0, "trust-admin"));
  stub.fcn = "AnchorBatch";
  stub.params = [domainId, value.batchId];
  if (!evidence) throw new Error("Missing fixture evidence");
  stub.transient.set("evidence", evidence);
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("initialization pins deployment-approved trust and cannot be used to replace it", async () => {
  const { ledger, stub } = await setup();
  stub.fcn = "Init";
  stub.params = [];
  stub.transient.clear();
  await expect(ledger.initialize(stub, identity(0, "trust-admin"))).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
  const replacement = new EvidenceLedger({ ...trust, generationId: randomUUID() });
  await expect(replacement.invoke(stub, identity())).rejects.toThrow("POLICY_DENIED");
});

test("private fields in args, surplus transient keys, expired keys and unrelated submitters are rejected", async () => {
  const { ledger, stub, value } = await setup();
  stub.params.push("price=123");
  await expect(ledger.invoke(stub, identity())).rejects.toThrow();
  stub.params = [domainId, value.batchId];
  stub.transient.set("unknown", Buffer.from("x"));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("INVALID_MESSAGE");
  stub.transient.delete("unknown");
  await expect(ledger.invoke(stub, identity(1))).rejects.toThrow("INVALID_MESSAGE");
  stub.timestamp = new Date("2031-01-01T00:00:00Z");
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("UNTRUSTED_IDENTITY");
});

test("collection config excludes third institution and requires both member peer endorsements", () => {
  const [collection] = fabricEvidenceCollections(trust);
  expect(collection).toEqual({
    name: "evidence_AB_v1",
    policy: "OR('AMSP.member','BMSP.member')",
    requiredPeerCount: 1,
    maxPeerCount: 3,
    blockToLive: 0,
    memberOnlyRead: true,
    memberOnlyWrite: true,
    endorsementPolicy: { signaturePolicy: "AND('AMSP.peer','BMSP.peer')" },
  });
  expect(() =>
    fabricEvidenceCollections({ ...trust, domains: [...trust.domains, ...trust.domains] }),
  ).toThrow();
});

test("missing PDC bytes with a committed hash cannot reset an issuer stream or replace an anchor", async () => {
  const { ledger, stub } = await setup();
  await ledger.invoke(stub, identity());
  stub.privateState.clear();
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("DATA_WAITING");
  const value = batch();
  stub.params = [domainId, value.batchId];
  stub.transient.set("evidence", Buffer.from(JSON.stringify(await envelope(value))));
  await expect(ledger.invoke(stub, identity())).rejects.toThrow("DATA_WAITING");
  expect(stub.privateState.size).toBe(0);
});
