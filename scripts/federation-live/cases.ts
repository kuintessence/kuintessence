import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPgDb,
  federationCaseAttempts,
  federationCasePublications,
  federationCaseRevocationDeliveries,
  federationCaseRevocationNotices,
  federationCaseSubmissions,
} from "@kuintessence/db";
import { CaseReceiptQuerySchema } from "@kuintessence/shared/federation/case-ledger";
import { z } from "zod";
import { UnixCaseClient } from "../../packages/server/src/federation/case-client";
import { FabricClientFailure } from "../../packages/server/src/federation/fabric-client";

const output = z.string().min(1).parse(process.env.LAB_EVIDENCE);
if (process.argv[2] === "snapshot") {
  const urls = [
    process.env.SOURCE_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.LAB_RECIPIENT_DATABASE_URL,
  ];
  assert.equal(new Set(urls).size, 3);
  const states = [];
  for (const raw of urls) {
    const url = z.string().min(1).parse(raw);
    assert(new URL(url).pathname.startsWith("/kuintessence_unit_"));
    const db = createPgDb(url);
    try {
      states.push({
        publications: await db.select().from(federationCasePublications),
        submissions: await db.select().from(federationCaseSubmissions),
        attempts: await db.select().from(federationCaseAttempts),
        notices: await db.select().from(federationCaseRevocationNotices),
        deliveries: await db.select().from(federationCaseRevocationDeliveries),
      });
    } finally {
      await db.$client.end();
    }
  }
  await writeFile(output, JSON.stringify(states, null, 2), { mode: 0o600 });
} else {
  assert.equal(process.argv[2], "receipts");
  const root = z.string().min(1).parse(process.env.LAB_FABRIC_ROOT);
  const query = CaseReceiptQuerySchema.parse(
    JSON.parse(z.string().parse(process.env.LAB_CASE_QUERY)),
  );
  const receipts = [];
  for (const name of ["A", "B", "R"]) {
    const client = new UnixCaseClient(join(root, `live-${name}-case/case.sock`));
    try {
      receipts.push(await client.receipt(query));
    } catch (error) {
      if (
        !(error instanceof FabricClientFailure) ||
        !["DATA_WAITING", "LEDGER_UNAVAILABLE"].includes(error.code)
      )
        throw error;
      receipts.push({ waiting: error.code });
    }
  }
  await writeFile(output, JSON.stringify(receipts), { mode: 0o600 });
}
