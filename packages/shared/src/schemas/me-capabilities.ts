import { z } from "zod";

export const PlatformCapabilitySchema = z.enum([
  "workspace.consumer.access",
  "workspace.provider.view",
  "workspace.provider.manage",
  "workspace.platform.view",
  "workspace.platform.manage",
  "workspace.audit.view",
  "workspace.ecosystem.view",
  "workspace.ecosystem.publish",
  "workspace.personal.access",
  "workflow.submit",
  "terminal.open",
  "storage.request",
  "software.publish",
  "audit.view",
  "audit.recording.view",
  "metering.report.view",
]);

export type PlatformCapability = z.infer<typeof PlatformCapabilitySchema>;

export const MeCapabilityContextSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.literal("personal"),
    type: z.literal("personal"),
  }),
  z.object({
    id: z.literal("platform"),
    type: z.literal("platform"),
  }),
  z.object({
    id: z.literal("audit"),
    type: z.literal("audit"),
  }),
  z.object({
    id: z.string().startsWith("organization:"),
    type: z.literal("organization"),
    organizationId: z.string().uuid(),
    membershipRole: z.enum(["owner", "admin", "operator", "member", "viewer"]),
  }),
]);

export type MeCapabilityContext = z.infer<typeof MeCapabilityContextSchema>;

export const MeCapabilitiesSchema = z.object({
  principal: z.object({
    userId: z.string().uuid().nullable(),
    email: z.string().email(),
    role: z.string(),
  }),
  capabilities: z.array(PlatformCapabilitySchema),
  contexts: z.array(MeCapabilityContextSchema),
  activeContextId: z.string(),
  devicePolicy: z.object({
    highRiskMutations: z.literal("desktop-only"),
    mobileMode: z.literal("observe-approve"),
  }),
});

export type MeCapabilities = z.infer<typeof MeCapabilitiesSchema>;
