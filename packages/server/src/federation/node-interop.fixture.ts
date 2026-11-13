import { FederationDelegationSchema } from "@kuintessence/shared/federation";
import { importPKCS8, importSPKI } from "jose";
import { z } from "zod";
import { signFederationMessage, verifyFederationMessage } from "./signatures";

// Executed by the interop test as compiled ESM under Node, with ephemeral keys over stdin.
const inputSchema = z.strictObject({
  publicKey: z.string(),
  privateKey: z.string(),
  siteId: z.string(),
  keyId: z.string(),
  now: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  jws: z.string(),
});
let source = "";
for await (const chunk of process.stdin) source += chunk.toString();
const input = inputSchema.parse(JSON.parse(source));
const verified = await verifyFederationMessage(
  FederationDelegationSchema,
  input.jws,
  {
    siteId: input.siteId,
    keyId: input.keyId,
    publicKey: await importSPKI(input.publicKey, "RS256"),
    validFrom: new Date(input.validFrom),
    validUntil: new Date(input.validUntil),
    revoked: false,
    allowedKinds: ["delegation"],
  },
  new Date(input.now),
);
const signed = await signFederationMessage(FederationDelegationSchema, verified.payload, {
  siteId: input.siteId,
  keyId: input.keyId,
  privateKey: await importPKCS8(input.privateKey, "RS256"),
});
process.stdout.write(JSON.stringify({ digest: verified.digest, jws: signed }));
