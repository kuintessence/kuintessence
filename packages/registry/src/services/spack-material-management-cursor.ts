import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  SpackMaterialDigestSchema,
  SpackMaterialManagementCursorSchema,
  type SpackMaterialManagementQuery,
} from "@kuintessence/shared";
import { z } from "zod";
import { SpackMaterialError } from "./spack-material-storage";

const payloadSchema = z.strictObject({
  digest: SpackMaterialDigestSchema,
  expiresAt: z.number().int().positive(),
});

/** Separate derived key and authenticated context; cursor contents never grant read access. */
export function managementCursor(
  secret: string,
  subject: string,
  query: SpackMaterialManagementQuery,
) {
  if (secret.length < 32) {
    throw new SpackMaterialError(503, "Material management cursor is not configured");
  }
  const key = createHmac("sha256", secret).update("kq:spack-management-cursor:v1").digest();
  const context = Buffer.from(
    JSON.stringify([subject, query.repository, query.state, query.limit]),
  );
  return {
    encode(digest: string) {
      const payload = payloadSchema.parse({ digest, expiresAt: Date.now() + 15 * 60_000 });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(context);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
      return `v1.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
    },
    decode(cursor: string) {
      try {
        SpackMaterialManagementCursorSchema.parse(cursor);
        const value = Buffer.from(cursor.slice(3), "base64url");
        if (value.toString("base64url") !== cursor.slice(3)) throw new Error("Noncanonical cursor");
        const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
        decipher.setAAD(context);
        decipher.setAuthTag(value.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
        const payload = payloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
        if (payload.expiresAt <= Date.now()) {
          throw new Error("Expired cursor");
        }
        return payload.digest;
      } catch {
        throw new SpackMaterialError(422, "Invalid or expired management cursor; restart the list");
      }
    },
  };
}
