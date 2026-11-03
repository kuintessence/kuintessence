import { z } from "zod";

export const ProviderProfileSchema = z
  .object({
    description: z.string().trim().max(2000).default(""),
    contactName: z.string().trim().max(120).default(""),
    email: z.union([z.literal(""), z.email().max(254)]).default(""),
    phone: z.string().trim().max(80).default(""),
    address: z.string().trim().max(500).default(""),
    website: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(2048)]).default(""),
  })
  .strict();
export const ComputeProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    profile: ProviderProfileSchema,
  })
  .strict();
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
export type ComputeProviderInput = z.infer<typeof ComputeProviderInputSchema>;
export type ComputeProvider = ComputeProviderInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  centerCount: number;
  agentCount: number;
  memberCount: number;
};
export type ComputeProviderDirectory = {
  items: ComputeProvider[];
  total: number;
  canManage: boolean;
};
