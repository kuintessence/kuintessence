import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import {
  agents,
  artifactReplicas,
  clusterExecutionAccounts,
  createPgDb,
  federationMaterials,
  federationPreparations,
  federationWorkflowBindings,
  jobs,
  netdriveFiles,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  schedulerQueues,
  softwareAssetRevisions,
  softwareAssets,
  userClusterAccountMappings,
  userOrgMemberships,
  users,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import { SoftwareAssetPayloadSchema, workflowDsl } from "@kuintessence/shared";
import {
  FederationAgreementSchema,
  FederationDelegationSchema,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { exportPKCS8, exportSPKI, importPKCS8, importSPKI } from "jose";
import { stringify } from "yaml";
import { z } from "zod";
import { FederationAgreementService } from "../../packages/server/src/federation/agreements";
import {
  FederationAssetService,
  federationMaterialDigest,
} from "../../packages/server/src/federation/assets";
import { FederationPermissionService } from "../../packages/server/src/federation/permissions";
import { signFederationMessage } from "../../packages/server/src/federation/signatures";
import { FederationTrustRegistry } from "../../packages/server/src/federation/trust-registry";
import { SoftwareAvailabilityService } from "../../packages/server/src/services/software-availability";
import { approveContract } from "./business";

const root = z.string().min(1).parse(process.env.LAB_ROOT);
if (
  !new URL(z.string().min(1).parse(process.env.DATABASE_URL)).pathname.startsWith(
    "/kuintessence_unit_",
  )
)
  throw Error("Isolated DB required");
const db = createPgDb(z.string().min(1).parse(process.env.DATABASE_URL));
const registration = await Bun.file(`${root}/registration.json`).json();
const actor = { orgId: registration.orgId, userId: registration.userId };
if (process.argv[2] === "inspect") {
  const probe = await Bun.file(`${root}/federation-probe.json`).json();
  const runs = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.submittedBy, probe.identity.userId));
  const bindings = await db.select().from(federationWorkflowBindings);
  const preparations = await db.select().from(federationPreparations);
  const artifacts = await db.select().from(workflowArtifacts);
  const replicas = await db.select().from(artifactReplicas);
  const files = await db.select().from(netdriveFiles);
  const submitted = await db.select().from(jobs).where(eq(jobs.submittedBy, probe.identity.userId));
  await Bun.write(
    `${root}/probe-state.json`,
    JSON.stringify({
      materialCount: (await db.select().from(federationMaterials)).length,
      artifacts,
      replicas,
      files,
      runs: runs.map(({ id, status, errorCode, errorMessage, result }) => ({
        id,
        status,
        errorCode,
        errorMessage,
        result,
      })),
      bindings: bindings.map(({ workflowRunId, reservationId }) => ({
        workflowRunId,
        reservationId,
      })),
      preparations,
      jobs: submitted.map(
        ({ id, status, schedulerJobId, placementTrace, reason, errorMessage }) => ({
          id,
          status,
          schedulerJobId,
          placementTrace,
          reason,
          errorMessage,
        }),
      ),
    }),
  );
} else {
  const identity = { ...actor, userId: crypto.randomUUID() };
  await db.insert(users).values({
    id: identity.userId,
    orgId: identity.orgId,
    email: "federation-execution@test.invalid",
    role: "user",
    serviceAccount: true,
  });
  await db
    .insert(userOrgMemberships)
    .values([actor, identity].map((x) => ({ ...x, role: "member" })))
    .onConflictDoNothing();
  for (const capability of ["agreement.approve", "asset.map"] as const)
    await new FederationPermissionService(db).set(
      { ...actor, capability, enabled: true },
      actor.userId,
    );
  const network = await Bun.file(`${process.env.LAB_FABRIC_ROOT}/network.json`).json();
  const site = network.sites.find((s: { name: string }) => s.name === "A");
  const pem = await Bun.file(site.businessKeyFile).text();
  const sourcePair = {
    privateKey: await importPKCS8(pem, "RS256", { extractable: true }),
    publicKey: await importSPKI(
      createPublicKey(pem).export({ format: "pem", type: "spki" }).toString(),
      "RS256",
    ),
  };
  const source = { siteId: site.siteId, keyId: "batch-1", privateKey: sourcePair.privateKey };
  const localPem = await Bun.file(
    z.string().min(1).parse(process.env.FEDERATION_SIGNING_KEY_FILE),
  ).text();
  const target = {
    siteId: z.string().min(1).parse(process.env.FEDERATION_SITE_ID),
    keyId: z.string().min(1).parse(process.env.FEDERATION_SIGNING_KEY_ID),
    privateKey: await importPKCS8(localPem, "RS256"),
  };
  const trust = new FederationTrustRegistry(db);
  const validFrom = new Date(Date.now() - 60000).toISOString(),
    validUntil = new Date(Date.now() + 3600000).toISOString();
  for (const [key, pem] of [
    [source, await exportSPKI(sourcePair.publicKey)],
    [target, createPublicKey(localPem).export({ format: "pem", type: "spki" }).toString()],
  ] as const) {
    await trust.addSite(
      {
        id: key.siteId,
        name: key.keyId,
        endpoint:
          key.siteId === source.siteId
            ? z.string().min(1).parse(process.env.LAB_SOURCE_ORIGIN)
            : "https://lab.invalid",
      },
      actor.userId,
    );
    await trust.addKey(
      key.siteId,
      {
        keyId: key.keyId,
        publicKeyPem: pem,
        allowedKinds: [
          "commercial-agreement",
          "commercial-reservation",
          "commercial-release",
          "commercial-terminal",
          "terminal-query",
          "terminal-chunk",
          "terminal-delivery",
          "terminal-ack",
          "commercial-usage",
          "agreement",
          "delegation",
          "acceptance",
          "evidence-batch",
          "status-query",
          "status-report",
          "result-query",
          "result-report",
          "result-download-query",
          "result-download-grant",
          "result-receipt",
          "result-receipt-ack",
          "material-query",
          "material-chunk",
        ],
        validFrom,
        validUntil,
      },
      actor.userId,
    );
  }
  await trust.addCertificate(
    source.siteId,
    { certificatePem: await Bun.file(`${root}/peer.crt`).text() },
    actor.userId,
  );
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.agentId, z.string().min(1).parse(process.env.LAB_AGENT)));
  assert(agent?.clusterId, "Registered cluster required");
  const [queue] = await db
    .select()
    .from(schedulerQueues)
    .where(eq(schedulerQueues.agentId, agent.agentId));
  if (!queue || !agent?.clusterId) throw Error("Agent/queue unavailable");
  const runtimeImage = process.env.LAB_RUNTIME_IMAGE;
  if (!runtimeImage) throw Error("Pinned runtime required");
  const outage = ["outage", "stop"].includes(process.env.LAB_SCENARIO ?? "");
  const producer = `set -euo pipefail
${outage ? "printf 'federation-sleep-started\\n'; sleep 600" : ""}
[ "$(id -u)" -gt 0 ]
grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status
grep -Eq '^Seccomp:[[:space:]]+2$' /proc/self/status
if (exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null; then exit 43; fi
value=$(cat /kq/inputs/value)
[ "$value" = "6" ]
printf '%s\\n' "$((value * 7))" > /kq/outputs/result
printf 'federation-file-produced:42\\n'
`;
  const consumer = `set -euo pipefail
[ "$(cat /kq/inputs/source)" = "42" ]
printf 'verified:%s\\n' "$(cat /kq/inputs/source)" > /kq/outputs/result
printf 'federation-file-consumed:42\\n'
`;
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Federation file transfer probe",
    parameters: [{ name: "value", type: "string", required: true }],
    spec: {
      nodeDrafts: [
        {
          id: "producer",
          name: "Write result file",
          type: "Script",
          source: { type: "Inline", language: "bash", content: producer },
          runtimeContractRef: { name: "bash", version: "1" },
          inputs: { value: { type: "Text" } },
          inputSlots: [{ descriptor: "value", type: "Text", from: { param: "value" } }],
          outputs: {
            result: { type: "File", durability: "Checkpoint" },
            optional: { type: "File", required: false },
          },
        },
        {
          id: "consumer",
          name: "Read result file",
          type: "Script",
          source: { type: "Inline", language: "bash", content: consumer },
          runtimeContractRef: { name: "bash", version: "1" },
          inputs: { source: { type: "File" } },
          inputSlots: [
            { descriptor: "source", type: "File", from: { node: "producer", output: "result" } },
          ],
          outputs: { result: { type: "File", durability: "Persistent" } },
        },
      ],
      nodeRelations: [{ fromId: "producer", toId: "consumer", slotRelations: [] }],
    },
  });
  const payload = SoftwareAssetPayloadSchema.parse({
    kind: "workflow-template",
    yamlContent: stringify(workflow),
  });
  if (runtimeImage) {
    const runtimeDigest = z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(runtimeImage.split("@")[1]);
    const profileId = crypto.randomUUID(),
      accountId = crypto.randomUUID();
    await db.insert(sandboxRuntimeProfiles).values({
      id: profileId,
      name: "Isolated signed Bash runtime",
      language: "bash",
      languageVersion: "5",
      ociDigest: runtimeDigest,
      signature: await Bun.file(`${root}/runtime-signature.txt`).text(),
      adapters: ["kubernetes"],
      securityRequirements: {},
      lifecycle: "active",
    });
    await db.insert(sandboxRuntimeContractBindings).values({
      providerOrgId: actor.orgId,
      agentId: agent.agentId,
      runtimeContractRef: "bash@1",
      runtimeProfileId: profileId,
      runtimeDigest,
      boundBy: actor.userId,
      attestationKeyId: "lab-sandbox",
      attestationSignature: await Bun.file(`${root}/runtime-signature.txt`).text(),
      attestedAt: new Date(),
    });
    await db.insert(clusterExecutionAccounts).values({
      id: accountId,
      providerOrgId: actor.orgId,
      agentId: agent.agentId,
      displayName: "Isolated Kubernetes worker",
      backendType: "kubernetes",
      namespace: z.string().min(1).parse(process.env.LAB_NAMESPACE),
      serviceAccount: "worker",
    });
    await db
      .insert(userClusterAccountMappings)
      .values({ userId: identity.userId, accountId, status: "approved" });
  }

  const assetId = crypto.randomUUID(),
    revisionId = crypto.randomUUID();
  await db.insert(softwareAssets).values({
    id: assetId,
    kind: "workflow-template",
    name: "Federation artifact transfer probe",
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: actor.userId,
    payload,
  });
  await db.insert(softwareAssetRevisions).values({ id: revisionId, assetId, revision: 1, payload });
  const availability = new SoftwareAvailabilityService(db);
  const assets = new FederationAssetService(db, {
    authorizeSoftware: (id, principal, capability) =>
      availability.assertAssetCapability(id, principal, capability),
  });
  const reference = {
    originSiteId: source.siteId,
    kind: "workflow" as const,
    id: crypto.randomUUID(),
    revision: "1",
    digest: federationMaterialDigest(payload),
  };
  await assets.register(actor, { reference, localRevisionId: revisionId });
  const inputs = {
    protocolVersion: 1 as const,
    kind: "inputs" as const,
    parameters: { value: "6" },
    datasets: [],
    bindings: [],
  };
  const environment = {
    protocolVersion: 1 as const,
    kind: "environment-lock" as const,
    target: { platform: "linux", architecture: "x86_64" },
    nativeLockDigest: federationMaterialDigest({ software: [], runtime: runtimeImage }),
    software: [],
    sandboxRuntime: {
      kind: "OCI" as const,
      digest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(runtimeImage.split("@")[1]),
    },
  };
  const initialMaterials = await db.select().from(federationMaterials);
  if (initialMaterials.length !== 0) throw new Error("Target must begin without seeded manifests");
  console.log("Confirmed target has zero material manifests before delegation");
  const terms = FederationAgreementSchema.parse({
    protocolVersion: 1,
    kind: "agreement",
    agreementRevisionId: crypto.randomUUID(),
    sourceSiteId: source.siteId,
    targetSiteId: target.siteId,
    mode: "ledger_coordinated",
    budgetDomainId: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    unit: "credit.micro",
    budgetLimit: "100",
    maxTaskAmount: "10",
    maxReservations: 10,
    validFrom,
    validUntil,
    templates: [reference],
    executionTargets: [
      {
        providerOrgId: actor.orgId,
        clusterId: agent.clusterId,
        agentId: agent.agentId,
        queueId: queue.queueId,
      },
    ],
    resourceLimit: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: outage ? 900 : 30 },
    resultPolicy: {
      scope: "persistent-files",
      maxFiles: 4,
      maxBytes: 1024,
      availableUntil: validUntil,
    },
    termsDigest: federationMaterialDigest({ purpose: "live runtime gate" }),
  });
  const commercial = await approveContract(db, actor, target, source, terms);
  const agreements = new FederationAgreementService(db, target);
  await agreements.approve(actor, { terms, executionUserId: identity.userId });
  await agreements.attachCounterparty(
    actor,
    terms.agreementRevisionId,
    await signFederationMessage(FederationAgreementSchema, terms, source),
  );
  const request = FederationDelegationSchema.parse({
    protocolVersion: 1,
    kind: "delegation",
    operationId: crypto.randomUUID(),
    senderSiteId: source.siteId,
    recipientSiteId: target.siteId,
    agreementRevisionId: terms.agreementRevisionId,
    mode: terms.mode,
    budgetDomainId: terms.budgetDomainId,
    epoch: terms.epoch,
    taskId: crypto.randomUUID(),
    attempt: 1,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1200000).toISOString(),
    executionExpiresAt: new Date(Date.now() + 1800000).toISOString(),
    template: reference,
    inputManifestDigest: federationMaterialDigest(inputs),
    environmentLockDigest: federationMaterialDigest(environment),
    resources: terms.resourceLimit,
    maxAmount: "1",
    unit: terms.unit,
  });
  await Bun.write(`${root}/source-signing.pem`, await exportPKCS8(sourcePair.privateKey), {
    mode: 0o600,
  });
  await Bun.write(
    `${root}/source-init.json`,
    JSON.stringify({
      source: {
        siteId: source.siteId,
        keyId: source.keyId,
        publicKeyPem: await exportSPKI(sourcePair.publicKey),
      },
      target: {
        siteId: target.siteId,
        keyId: target.keyId,
        publicKeyPem: createPublicKey(localPem).export({ format: "pem", type: "spki" }).toString(),
      },
      commercial,
      terms,
      inputs,
      environment,
      payload,
      reference,
      request,
      targetApprovalJws: (await agreements.get(actor, terms.agreementRevisionId)).approvalJws,
    }),
  );
  await Bun.write(
    `${root}/delegation.jws`,
    await signFederationMessage(FederationDelegationSchema, request, source),
  );
  await Bun.write(
    `${root}/federation-probe.json`,
    JSON.stringify({ identity, agreementId: terms.agreementRevisionId }),
  );
}
await db.$client.end();
