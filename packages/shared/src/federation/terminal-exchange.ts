import { z } from "zod";
import { FederationDigestSchema } from "./references";
import {
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  hasFederationQueryWindow,
} from "./status";

export const TERMINAL_CHUNK_BYTES = 65_536;
export const TERMINAL_MAX_BYTES = 16_777_216;
const identity = { ...FederationStatusQuerySchema.shape, agreementDigest: FederationDigestSchema };
const response = {
  ...FederationStatusReportSchema.omit({ preparation: true, workflow: true }).shape,
  agreementDigest: FederationDigestSchema,
};
export const TerminalQuerySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("terminal-query"),
    terminalId: z.uuid().nullable(),
    proposalDigest: FederationDigestSchema.nullable(),
    offset: z
      .number()
      .int()
      .min(0)
      .max(TERMINAL_MAX_BYTES - 1)
      .refine((n) => n % TERMINAL_CHUNK_BYTES === 0),
  })
  .refine(hasFederationQueryWindow)
  .refine(
    (v) =>
      (v.terminalId === null) === (v.proposalDigest === null) &&
      (v.offset === 0 || v.terminalId !== null),
  );
export const TerminalChunkSchema = z.strictObject({
  ...response,
  kind: z.literal("terminal-chunk"),
  item: z
    .strictObject({
      terminalId: z.uuid(),
      proposalDigest: FederationDigestSchema,
      offset: z
        .number()
        .int()
        .min(0)
        .max(TERMINAL_MAX_BYTES - 1)
        .refine((n) => n % TERMINAL_CHUNK_BYTES === 0),
      totalBytes: z.number().int().min(1).max(TERMINAL_MAX_BYTES),
      bytes: z
        .string()
        .min(4)
        .max(87384)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .nullable(),
});
export const TerminalDeliverySchema = z
  .strictObject({
    ...identity,
    kind: z.literal("terminal-delivery"),
    terminalId: z.uuid(),
    terminalDigest: FederationDigestSchema,
    sourceJws: z.string().min(1).max(16384),
    reviewedAt: z.iso.datetime(),
  })
  .refine(hasFederationQueryWindow);
export const TerminalAckSchema = z.strictObject({
  ...response,
  kind: z.literal("terminal-ack"),
  terminalId: z.uuid(),
  terminalDigest: FederationDigestSchema,
});
