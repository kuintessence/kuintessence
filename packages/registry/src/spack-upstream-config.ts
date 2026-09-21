import { isAbsolute } from "node:path";
import { positiveInt } from "@kuintessence/shared";
import { z } from "zod";
import { parseUpstreamOrigins, parseUpstreamProxy } from "./services/spack-upstream-policy";

const proxySchema = z
  .string()
  .transform((raw, ctx) => {
    if (!raw) return undefined;
    try {
      return parseUpstreamProxy(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid Spack upstream proxy configuration" });
      return z.NEVER;
    }
  })
  .optional();

const originsSchema = z
  .string()
  .default("[]")
  .transform((raw, ctx) => {
    try {
      return parseUpstreamOrigins(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected unique HTTPS public origins on port 443" });
      return z.NEVER;
    }
  });

export const spackUpstreamConfigFields = {
  SPACK_UPSTREAM_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SPACK_UPSTREAM_PROXY_URL: proxySchema,
  SPACK_UPSTREAM_ALLOWED_ORIGINS: originsSchema,
  SPACK_UPSTREAM_TIMEOUT_MS: positiveInt(300_000).pipe(z.number().max(30 * 60_000)),
  SPACK_UPSTREAM_IDLE_TIMEOUT_MS: positiveInt(30_000).pipe(z.number().max(30 * 60_000)),
  SPACK_UPSTREAM_MAX_CONCURRENT: positiveInt(2).pipe(z.number().max(4)),
  SPACK_UPSTREAM_MAX_BYTES: positiveInt(1024 ** 3).pipe(z.number().max(16 * 1024 ** 3)),
  SPACK_UPSTREAM_CA_BUNDLE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().refine(isAbsolute, "must be absolute").optional(),
  ),
};
