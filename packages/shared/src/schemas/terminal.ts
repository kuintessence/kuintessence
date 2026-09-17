import { z } from "zod";

export const TerminalAuthMethodEnum = z.enum(["password", "key", "kerberos"]);
export const TerminalSessionStateEnum = z.enum(["opening", "open", "closed", "errored"]);

export const TerminalSessionCreateSchema = z.object({
  siteId: z.string().min(1).max(255),
  agentId: z.string().min(1).max(255),
  remoteUser: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, "Must be a POSIX username"),
  authMethod: TerminalAuthMethodEnum,
  // The HTTP terminal does not consume this optional credential; never log it.
  secret: z.string().max(8192).optional(),
});

export const TerminalExecSchema = z.object({
  input: z.string().min(1).max(8192),
});

export const TerminalResizeSchema = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

export const TerminalSessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  siteId: z.string(),
  agentId: z.string(),
  remoteUser: z.string(),
  authMethod: TerminalAuthMethodEnum,
  state: TerminalSessionStateEnum,
  cols: z.number().int(),
  rows: z.number().int(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  reason: z.string().nullable(),
});

export const TerminalAuditFrameSchema = z.object({
  ts: z.string(),
  kind: z.enum(["stdin", "stdout", "stderr", "resize", "error", "exit"]),
  data: z.string(),
});

export type TerminalAuthMethod = z.infer<typeof TerminalAuthMethodEnum>;
export type TerminalSessionState = z.infer<typeof TerminalSessionStateEnum>;
export type TerminalSessionCreate = z.infer<typeof TerminalSessionCreateSchema>;
export type TerminalExec = z.infer<typeof TerminalExecSchema>;
export type TerminalResize = z.infer<typeof TerminalResizeSchema>;
export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalAuditFrame = z.infer<typeof TerminalAuditFrameSchema>;
