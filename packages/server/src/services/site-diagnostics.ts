import { createHash, randomBytes, randomUUID, verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import type { MinioBackend } from "../storage/minio-client";

export const siteDiagnosticProofSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    certificate: z.string().max(8192),
    timestamp: z.number().int(),
    nonce: z.string().regex(/^[a-f0-9]{48}$/),
    signature: z.string().min(1).max(4096),
  })
  .strict();
const partsSchema = z
  .array(
    z
      .object({ partNumber: z.number().int().min(1).max(2), etag: z.string().min(1).max(256) })
      .strict(),
  )
  .length(2);
const TTL = 5 * 60_000;
const CONTENT_TYPE = "application/octet-stream";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const denied = () => new Error("Site diagnostic request rejected");

interface Session {
  agentId: string;
  fingerprint: string;
  expires: number;
  keys: string[];
  uploadId?: string;
  timer?: ReturnType<typeof setTimeout>;
}
export interface SiteDiagnosticsOptions {
  storage: MinioBackend;
  certificate(agentId: string, fingerprint: string): Promise<boolean>;
  agentExists(agentId: string): Promise<boolean>;
}

export function createSiteDiagnosticsService(options: SiteDiagnosticsOptions) {
  const sessions = new Map<string, Session>();
  const nonces = new Map<string, number>();
  const storage = options.storage;
  const cleanup = async (ticket: string) => {
    const session = sessions.get(ticket);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    sessions.delete(ticket);
    const results = await Promise.allSettled([
      ...(session.uploadId
        ? [
            storage.abortMultipartUpload(session.keys[2] as string, session.uploadId).then(() => {
              session.uploadId = undefined;
            }),
          ]
        : []),
      ...session.keys.map((key) => storage.delete(key)),
    ]);
    // Expired diagnostic objects are isolated under site-diagnostics/. Failed cleanup is retryable.
    if (results.some((result) => result.status === "rejected")) {
      sessions.set(ticket, session);
      session.timer = setTimeout(() => {
        void cleanup(ticket).catch(() => {});
      }, 60_000);
      session.timer.unref();
      throw new Error("Diagnostic cleanup incomplete");
    }
  };
  const sessionFor = async (ticket: string | undefined) => {
    if (!ticket || !/^[a-f0-9]{64}$/.test(ticket)) throw denied();
    const session = sessions.get(ticket);
    if (
      !session ||
      session.expires < Date.now() ||
      !(await options.certificate(session.agentId, session.fingerprint)) ||
      !(await options.agentExists(session.agentId))
    )
      throw denied();
    return session;
  };
  return {
    async create(raw: unknown) {
      const input = siteDiagnosticProofSchema.parse(raw);
      const now = Date.now();
      if (Math.abs(now - input.timestamp) > 60_000) throw denied();
      const cert = new X509Certificate(input.certificate);
      const fingerprint = createHash("sha256").update(cert.raw).digest("hex");
      const payload = `kq-site-diagnostics-v1\n${input.agentId}\n${input.timestamp}\n${input.nonce}`;
      if (
        !verify(
          "sha256",
          Buffer.from(payload),
          cert.publicKey,
          Buffer.from(input.signature, "base64"),
        ) ||
        !(await options.certificate(input.agentId, fingerprint)) ||
        !(await options.agentExists(input.agentId))
      )
        throw denied();
      for (const [nonce, expiry] of nonces) if (expiry < now) nonces.delete(nonce);
      const nonceKey = `${fingerprint}:${input.nonce}`;
      if (nonces.has(nonceKey) || nonces.size >= 4096 || sessions.size >= 64) throw denied();
      nonces.set(nonceKey, now + 60_000);
      const ticket = randomBytes(32).toString("hex");
      const prefix = `site-diagnostics/${randomUUID()}`;
      const session: Session = {
        agentId: input.agentId,
        fingerprint,
        expires: now + TTL,
        keys: [`${prefix}/get`, `${prefix}/put`, `${prefix}/multipart`],
      };
      sessions.set(ticket, session);
      session.timer = setTimeout(() => {
        void cleanup(ticket).catch(() => {});
      }, TTL);
      session.timer.unref();
      try {
        const body = `kq site diagnostic ${input.nonce}\n`;
        await storage.putBlob(session.keys[0] as string, Buffer.from(body), CONTENT_TYPE);
        const objectGet = {
          url: await storage.presignDownload(session.keys[0] as string, TTL / 1000),
          size: Buffer.byteLength(body),
          sha256: hash(body),
        };
        const putBody = `${body}put\n`;
        const partBodies = ["k".repeat(5 * 1024 * 1024), `${body}multipart\n`];
        const { uploadId } = await storage.createMultipartUpload(
          session.keys[2] as string,
          CONTENT_TYPE,
        );
        session.uploadId = uploadId;
        const endpoint = (action: string) => `agent/site-diagnostics/${action}?ticket=${ticket}`;
        return {
          version: 1 as const,
          identity: { agentId: input.agentId },
          cleanupUrl: endpoint("session"),
          fixtures: {
            version: 1 as const,
            material: {
              url: endpoint("material"),
              size: Buffer.byteLength(body),
              sha256: hash(body),
            },
            objectGet,
            objectPut: {
              url: await storage.presignUpload(session.keys[1] as string, TTL / 1000),
              body: putBody,
              verify: {
                url: await storage.presignDownload(session.keys[1] as string, TTL / 1000),
                size: Buffer.byteLength(putBody),
                sha256: hash(putBody),
              },
            },
            multipart: {
              parts: await Promise.all(
                partBodies.map(async (part, i) => ({
                  url: await storage.presignUploadPart(
                    session.keys[2] as string,
                    uploadId,
                    i + 1,
                    TTL / 1000,
                  ),
                  body: part,
                })),
              ),
              completeUrl: endpoint("complete"),
              abortUrl: endpoint("session"),
              verify: {
                url: await storage.presignDownload(session.keys[2] as string, TTL / 1000),
                size: Buffer.byteLength(partBodies.join("")),
                sha256: hash(partBodies.join("")),
              },
            },
          },
        };
      } catch (error) {
        await cleanup(ticket).catch(() => {});
        throw error;
      }
    },
    async material(ticket: string | undefined) {
      const session = await sessionFor(ticket);
      return storage.getBlob(session.keys[0] as string);
    },
    async complete(ticket: string | undefined, raw: unknown) {
      const session = await sessionFor(ticket);
      const parts = partsSchema.parse(raw);
      if (parts[0]?.partNumber !== 1 || parts[1]?.partNumber !== 2 || !session.uploadId)
        throw denied();
      await storage.completeMultipartUpload(session.keys[2] as string, session.uploadId, parts);
      session.uploadId = undefined;
    },
    async cleanup(ticket: string | undefined) {
      await sessionFor(ticket);
      await cleanup(ticket as string);
    },
  };
}
export type SiteDiagnosticsService = ReturnType<typeof createSiteDiagnosticsService>;
