import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SpackMaterialBindingSchema } from "@kuintessence/shared";
import { z } from "zod";

export const caseDirectory = "/scratch/kq-spack-case";
export const ReleaseSchema = z.object({
  binding: SpackMaterialBindingSchema,
  spec: z.string(),
  target: z.string(),
  manifestSize: z.number().int().positive(),
  recipeId: z.string().regex(/^[a-f0-9]{64}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
export const OperationSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed", "rejected"]),
  error: z.string().nullable(),
  stderr: z.string().nullable(),
});

export async function login(origin: string) {
  assert.equal(process.env.KQ_PR_TEST, "1");
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "scheduler-compose-seed@kuintessence.test",
      role: "platform_admin",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `Case login: HTTP ${response.status}`);
  return z.object({ token: z.string().min(1) }).parse(await response.json()).token;
}

export async function jsonRequest(origin: string, token: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(body === undefined ? {} : { "Idempotency-Key": randomUUID() }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  // Never embed arbitrary response bodies: registration and auth carry secrets.
  assert(response.ok, `${path.split("?")[0]}: HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}
