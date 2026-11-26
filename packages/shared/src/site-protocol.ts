import { z } from "zod";

// Bump for incompatible site HTTP, connectRPC, enrollment or transfer contract changes.
// SQLite/state migrations remain governed separately by the release's stateFormat.
export const SITE_PROTOCOL_VERSION = 1;

const protocolVersion = z.number().int().min(1).max(2147483647);

export const siteProtocolRangeSchema = z
  .strictObject({ min: protocolVersion, max: protocolVersion })
  .refine((range) => range.min <= range.max, "Invalid site protocol range");
