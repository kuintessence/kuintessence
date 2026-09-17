/**
 * SSH credential vault admin schemas (PRD F17).
 *
 * Wire shapes for the CP-admin endpoints that set/rotate the per-agent SSH
 * credentials stored (encrypted) in the vault. The auth material
 * (password / private key / passphrase) only ever travels inbound on a PUT;
 * the read-back view ({@link SshCredentialView}) never includes it, exposing
 * only `hasSecret` so the form can show whether a credential is configured.
 */
import { z } from "zod";

/** Wire shape for `PUT /api/admin/ssh-credentials/:agentId`. */
export const SshCredentialUpsertSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  /** At least one of password / privateKey should be set for the session to
   *  authenticate; the schema permits neither (the gateway then closes the
   *  session with "auth payload missing") so a host-only row can be staged. */
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  /** Base64 SHA-256 of the expected host public key. Empty = no pin (unverified). */
  hostKeySha256: z.string().optional(),
});
export type SshCredentialUpsert = z.infer<typeof SshCredentialUpsertSchema>;

/** Secret-free read-back row for the admin list view. */
export interface SshCredentialView {
  agentId: string;
  host: string;
  port: number;
  username: string;
  hasSecret: boolean;
  /** Base64 SHA-256 host-key pin (not secret); "" when unpinned. */
  hostKeySha256: string;
  updatedAt: string | null;
  updatedBy: string | null;
}
