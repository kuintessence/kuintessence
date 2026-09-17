import { SchedulerTypeEnum } from "@kuintessence/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AgentRegistrationService } from "../services/agent-registration";

const MetadataSchema = z.object({
  token: z.string().min(1),
});

const CompleteSchema = z.object({
  token: z.string().min(1),
  csrPem: z.string().min(1),
  schedulerType: SchedulerTypeEnum,
  schedulerVersion: z.string().min(1),
  siteId: z.string().min(1).optional(),
  clusterId: z.string().min(1).optional(),
  topology: z.record(z.string(), z.unknown()).optional(),
});

export function createAgentRegistrationRoutes(service: AgentRegistrationService): Hono {
  const r = new Hono();

  r.post("/agent-registration/metadata", async (c) => {
    const body = MetadataSchema.parse(await c.req.json());
    const metadata = await service.metadata(body.token);
    return c.json({
      id: metadata.id,
      agentId: metadata.agentId,
      siteName: metadata.siteName,
      providerOrgId: metadata.providerOrgId,
      expiresAt: metadata.expiresAt.toISOString(),
    });
  });

  r.post("/agent-registration/complete", async (c) => {
    const body = CompleteSchema.parse(await c.req.json());
    const result = await service.complete(body);
    return c.json(
      {
        agentId: result.agentId,
        siteName: result.siteName,
        providerOrgId: result.providerOrgId,
        certPem: result.certPem,
        caCertPem: result.caCertPem,
        fingerprintSha256: result.fingerprintSha256,
        expiresAt: result.expiresAt.toISOString(),
      },
      201,
    );
  });

  return r;
}
