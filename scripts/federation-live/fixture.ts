import { randomBytes, randomUUID } from "node:crypto";
import type { createPgDb } from "@kuintessence/db";
import type { FederationAgreement } from "@kuintessence/shared/federation";
import { CommercialAgreementSchema } from "@kuintessence/shared/federation/commercial";
import { z } from "zod";
import { FederationCommercialAgreementService } from "../../packages/server/src/federation/commercial-agreements";
import type { FederationSigningKey } from "../../packages/server/src/federation/signatures";

export const ExecutionFixtureSchema = z.object({
  domainId: z.uuid(),
  sites: z
    .array(
      z.object({ name: z.enum(["A", "B"]), siteId: z.uuid(), businessKeyFile: z.string().min(1) }),
    )
    .length(2),
});
export async function executionFixture() {
  const root = z.string().min(1).parse(process.env.LAB_FIXTURE_ROOT);
  return ExecutionFixtureSchema.parse(await Bun.file(`${root}/execution-fixture.json`).json());
}

export async function approveContract(
  db: ReturnType<typeof createPgDb>,
  actor: { userId: string; orgId: string },
  own: FederationSigningKey,
  terms: FederationAgreement,
  existing?: unknown,
) {
  const fixture = await executionFixture();
  const contract = CommercialAgreementSchema.parse(
    existing ?? {
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId: fixture.domainId,
      salt: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
      agreement: terms,
      consideration: "exchange",
      priceVersionId: randomUUID(),
      prices: [
        {
          metric: "job.elapsed",
          quantityUnit: "job-millisecond",
          perQuantity: "1000",
          amount: "1",
        },
      ],
      termsText: "Private isolated execution acceptance contract",
    },
  );
  const service = new FederationCommercialAgreementService(db, own);
  await service.approve(actor, contract);
  return contract;
}
