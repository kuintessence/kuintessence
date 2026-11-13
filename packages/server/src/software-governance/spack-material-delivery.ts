import { createHash, verify, X509Certificate } from "node:crypto";
import {
  AppError,
  createLogger,
  ErrorCode,
  type SpackExecutionPin,
  SpackExecutionPinSchema,
  type SpackMaterialBinding,
  SpackMaterialBindingSchema,
  SpackMaterialDigestSchema,
  type SpackMaterialManifest,
  SpackMaterialManifestSchema,
  spackMaterialBlobs,
} from "@kuintessence/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";

const ISSUER = "kq-spack-delivery";
const AUDIENCE = "kq-agent-spack";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const logger = createLogger("spack-material-delivery");
const claimsSchema = SpackMaterialBindingSchema.extend({
  operationId: z.string().uuid(),
  agentId: z.string().min(1).max(256),
  requestedBy: z.string().uuid(),
  providerOrgId: z.string().nullable(),
  certificateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  spec: z.string().min(1).max(4096),
  auditOnly: z.boolean().optional(),
});
type MaterialClaims = z.infer<typeof claimsSchema>;

export interface SpackOperationAccess {
  auditOnly?: boolean;
  agentId: string;
  requestedBy: string;
  providerOrgId: string | null;
  spec: string;
}

export interface SpackDeliveryAccess {
  /** Recheck operation state, requester membership/role and policy on every request. */
  operation(operationId: string): Promise<SpackOperationAccess | null>;
  certificate(agentId: string, fingerprint: string): Promise<boolean>;
}

export interface SpackInstallPreparation {
  expectedPin?: SpackExecutionPin;
  operationId: string;
  agentId: string;
  requestedBy: string;
  spec: string;
}

export interface SpackInstallTicket {
  spackMaterialTicket: string;
  spackManifestDigest: string;
}

export interface SpackMaterialReferencePort {
  registerBindings(bindings: Record<string, SpackMaterialBinding>): Promise<void>;
  seedConfiguration(bindings: Record<string, SpackMaterialBinding>): Promise<void>;
  resolveOperation(
    input: SpackInstallPreparation & { providerOrgId: string | null },
  ): Promise<SpackMaterialBinding>;
  acquireOperation(input: SpackInstallPreparation & SpackMaterialBinding): Promise<void>;
}

export interface SpackMaterialDeliveryOptions {
  registryUrl: string;
  allowInsecureRegistryHttp?: boolean;
  registryJwtSecret: string;
  registryJwtIssuer?: string;
  registryJwtAudience?: string;
  ticketSecret: string;
  bindings: Record<string, SpackMaterialBinding>;
  references: SpackMaterialReferencePort;
  access: SpackDeliveryAccess;
  dispatcher: Pick<AgentDispatcher, "getChannel">;
  fetch?: typeof fetch;
  downloadLifetimeMs?: number;
  ticketLifetimeSec?: number;
  onPrepared?: (
    input: SpackInstallPreparation &
      SpackMaterialBinding & {
        nativeLockDigest: string;
        certificateFingerprint: string;
      },
  ) => Promise<void>;
}

export class SpackMaterialDelivery {
  private readonly fetcher: typeof fetch;
  private readonly key: Uint8Array;
  private readonly registryKey: Uint8Array;
  private readonly registryUrl: string;
  private activeDownloads = 0;
  private initialization?: Promise<void>;

  constructor(private readonly options: SpackMaterialDeliveryOptions) {
    const ticketLifetimeSec = options.ticketLifetimeSec ?? 900;
    if (!Number.isInteger(ticketLifetimeSec) || ticketLifetimeSec < 30 || ticketLifetimeSec > 900)
      throw new Error("Spack material ticket lifetime must be between 30 and 900 seconds");
    const url = new URL(options.registryUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Spack Registry URL must be an HTTP(S) origin");
    }
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !options.allowInsecureRegistryHttp
    ) {
      throw new Error("Spack Registry requires HTTPS; private HTTP must be explicitly enabled");
    }
    this.registryUrl = url.origin;
    this.fetcher = options.fetch ?? fetch;
    this.key = new TextEncoder().encode(options.ticketSecret);
    this.registryKey = new TextEncoder().encode(options.registryJwtSecret);
  }

  async initialize(): Promise<void> {
    this.initialization ??= this.options.references
      .registerBindings(this.options.bindings)
      .then(() => this.options.references.seedConfiguration(this.options.bindings))
      .catch(() => {
        this.initialization = undefined;
        throw referenceFailure();
      });
    await this.initialization;
  }

  async prepareOperation(input: SpackInstallPreparation): Promise<SpackInstallTicket> {
    const channel = this.options.dispatcher.getChannel(input.agentId);
    if (!channel?.spackMaterialDeliveryV1 || !channel.verifiedCertFingerprint) {
      throw denied("Spack material delivery requires a verified mTLS Agent with v1 capability");
    }
    const access = await this.options.access.operation(input.operationId);
    if (
      !access ||
      access.agentId !== input.agentId ||
      access.requestedBy !== input.requestedBy ||
      access.spec !== input.spec
    ) {
      throw denied();
    }
    if (!(await this.options.access.certificate(input.agentId, channel.verifiedCertFingerprint))) {
      throw denied();
    }
    await this.initialize();
    let binding: SpackMaterialBinding;
    try {
      binding = await this.options.references.resolveOperation({
        ...input,
        providerOrgId: access.providerOrgId,
      });
    } catch {
      throw referenceFailure();
    }
    const claims = claimsSchema.parse({
      ...binding,
      operationId: input.operationId,
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      spec: input.spec,
      providerOrgId: access.providerOrgId,
      auditOnly: access.auditOnly === true,
      certificateFingerprint: channel.verifiedCertFingerprint,
    });
    await this.authorize(claims);
    const manifest = await this.manifest(claims);
    if (input.expectedPin) {
      const pin = SpackExecutionPinSchema.parse(input.expectedPin);
      if (
        pin.manifestDigest !== claims.manifestDigest ||
        manifest.value.version !== 2 ||
        pin.lockfileDigest !== manifest.value.lockfile.digest ||
        pin.spackVersion !== manifest.value.spackVersion ||
        pin.target !== manifest.value.target
      )
        throw denied("Spack material release differs from the authorized execution pin");
    }
    await this.acquireReference(claims);
    await this.options.onPrepared?.({
      ...input,
      ...binding,
      nativeLockDigest: manifest.value.lockfile.digest,
      certificateFingerprint: claims.certificateFingerprint,
    });
    const ticket = await new SignJWT({ material: claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(input.agentId)
      .setIssuedAt()
      .setExpirationTime(`${this.options.ticketLifetimeSec ?? 900}s`)
      .sign(this.key);
    return { spackMaterialTicket: ticket, spackManifestDigest: claims.manifestDigest };
  }

  async refresh(operationId: string, body: unknown): Promise<SpackInstallTicket> {
    const input = z
      .object({
        certificate: z.string().max(8192),
        manifestDigest: SpackMaterialDigestSchema,
        timestamp: z.number().int(),
        signature: z
          .string()
          .regex(/^[A-Za-z0-9+/]+=*$/)
          .max(8192),
      })
      .strict()
      .parse(body);
    if (Math.abs(Date.now() - input.timestamp) > 60_000) throw denied();
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(input.certificate);
    } catch {
      throw denied();
    }
    const fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
    const access = await this.options.access.operation(operationId);
    if (
      !access ||
      !(await this.options.access.certificate(access.agentId, fingerprint)) ||
      this.options.dispatcher.getChannel(access.agentId)?.verifiedCertFingerprint !== fingerprint
    )
      throw denied();
    const message = `kq-material-refresh-v1\n${operationId}\n${input.manifestDigest}\n${input.timestamp}`;
    if (
      !verify(
        "sha256",
        Buffer.from(message),
        certificate.publicKey,
        Buffer.from(input.signature, "base64"),
      )
    )
      throw denied();
    const ticket = await this.prepareOperation({
      operationId,
      agentId: access.agentId,
      requestedBy: access.requestedBy,
      spec: access.spec,
    });
    if (ticket.spackManifestDigest !== input.manifestDigest)
      throw denied("Material renewal cannot change the pinned release");
    return ticket;
  }

  async download(
    operationId: string,
    ticket: string,
    digest?: string,
    request: { range?: string; ifRange?: string } = {},
  ): Promise<Response> {
    let claims: MaterialClaims;
    let expiresAt: number;
    try {
      const { payload } = await jwtVerify(ticket, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
        requiredClaims: ["exp", "iat", "sub"],
        maxTokenAge: "15m",
      });
      claims = claimsSchema.parse(payload.material);
      if (payload.sub !== claims.agentId || operationId !== claims.operationId || !payload.exp) {
        throw new Error("Invalid binding");
      }
      expiresAt = payload.exp * 1000;
    } catch {
      throw new AppError(ErrorCode.UNAUTHORIZED, "Invalid or expired Spack material ticket", 401);
    }
    await this.authorize(claims);
    await this.initialize();
    await this.acquireReference(claims);
    if (this.activeDownloads >= 8) {
      throw new AppError(ErrorCode.RATE_LIMITED, "Spack delivery is busy; retry later", 429);
    }
    this.activeDownloads++;
    let streaming = false;
    try {
      const manifest = await this.manifest(claims);
      if (digest === undefined) {
        return new Response(manifest.bytes, {
          headers: {
            "Content-Type": "application/json",
            "X-Kq-Spack-Mode": claims.auditOnly ? "source-audit" : "install",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      const parsedDigest = SpackMaterialDigestSchema.safeParse(digest);
      const blob = parsedDigest.success
        ? spackMaterialBlobs(manifest.value).find((item) => item.digest === parsedDigest.data)
        : undefined;
      if (!blob)
        throw new AppError(ErrorCode.NOT_FOUND, "Material is not part of this release", 404);
      const etag = `"${blob.digest}"`;
      let offset = 0;
      const range = request.ifRange && request.ifRange !== etag ? undefined : request.range;
      if (range) {
        const match = /^bytes=(0|[1-9][0-9]*)-$/.exec(range);
        if (!match || !Number.isSafeInteger(Number(match[1])))
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Only open-ended byte ranges are supported",
            400,
          );
        offset = Number(match[1]);
        if (offset >= blob.size)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${blob.size}`, ETag: etag },
          });
      }
      const lifetimeMs = Math.max(
        1,
        Math.min(this.options.downloadLifetimeMs ?? 300_000, expiresAt - Date.now()),
      );
      const response = await this.registry(claims, `/blobs/${blob.digest}`, lifetimeMs);
      if (!response.body) throw upstreamFailure();
      const stream = verifiedStream(
        response.body,
        blob.digest,
        blob.size,
        lifetimeMs,
        () => {
          this.activeDownloads--;
        },
        offset,
      );
      streaming = true;
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(blob.size - offset),
          "Accept-Ranges": "bytes",
          ETag: etag,
          ...(range ? { "Content-Range": `bytes ${offset}-${blob.size - 1}/${blob.size}` } : {}),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } finally {
      if (!streaming) this.activeDownloads--;
    }
  }

  private async acquireReference(claims: MaterialClaims): Promise<void> {
    try {
      await this.options.references.acquireOperation({
        operationId: claims.operationId,
        agentId: claims.agentId,
        requestedBy: claims.requestedBy,
        spec: claims.spec,
        repositoryId: claims.repositoryId,
        manifestDigest: claims.manifestDigest,
      });
    } catch {
      throw referenceFailure();
    }
  }

  private async authorize(claims: MaterialClaims) {
    const current = await this.options.access.operation(claims.operationId);
    if (
      !current ||
      current.agentId !== claims.agentId ||
      current.requestedBy !== claims.requestedBy ||
      current.providerOrgId !== claims.providerOrgId ||
      current.spec !== claims.spec ||
      (current.auditOnly === true) !== (claims.auditOnly === true) ||
      !(await this.options.access.certificate(claims.agentId, claims.certificateFingerprint))
    ) {
      throw denied();
    }
  }

  private async manifest(claims: MaterialClaims) {
    const response = await this.registry(claims, "", 30_000);
    if (!response.body) throw upstreamFailure();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_MANIFEST_BYTES) throw upstreamFailure();
        chunks.push(part.value);
      }
    } finally {
      closeReader(reader);
    }
    const bytes = Buffer.concat(chunks);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== claims.manifestDigest) {
      throw upstreamFailure();
    }
    let value: SpackMaterialManifest;
    try {
      value = SpackMaterialManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw upstreamFailure();
    }
    const repositoryId = createHash("sha256").update(value.repository).digest("hex");
    const [kind, owner] = value.repository.split("/");
    if (
      repositoryId !== claims.repositoryId ||
      value.spec !== claims.spec ||
      !(kind === "public" || (kind === "org" && owner === claims.providerOrgId))
    ) {
      throw denied("Spack material release is outside the Agent provider scope");
    }
    return { value, bytes };
  }

  private async registry(claims: MaterialClaims, suffix: string, timeoutMs: number) {
    // Canonical Registry resolution replaces role/org claims using the live user record.
    let builder = new SignJWT({ role: "user", orgIds: [] })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.requestedBy)
      .setIssuedAt()
      .setExpirationTime("60s");
    if (this.options.registryJwtIssuer) builder = builder.setIssuer(this.options.registryJwtIssuer);
    if (this.options.registryJwtAudience)
      builder = builder.setAudience(this.options.registryJwtAudience);
    const credential = await builder.sign(this.registryKey);
    try {
      const response = await this.fetcher(
        `${this.registryUrl}/api/spack/material-repositories/${claims.repositoryId}/releases/${claims.manifestDigest}${suffix}`,
        {
          headers: { Authorization: `Bearer ${credential}` },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {
          logger.warn("Could not cancel rejected Spack material response");
        });
        throw upstreamFailure();
      }
      return response;
    } catch {
      throw upstreamFailure();
    }
  }
}

function denied(message = "Spack operation authorization is no longer valid") {
  return new AppError(ErrorCode.FORBIDDEN, message, 403);
}

function upstreamFailure() {
  return new AppError(
    ErrorCode.INTERNAL_ERROR,
    "Spack Registry material is unavailable or invalid",
    502,
  );
}

function referenceFailure() {
  return new AppError(
    ErrorCode.INTERNAL_ERROR,
    "Spack material reference registry is unavailable or the operation reference is invalid",
    503,
  );
}

function verifiedStream(
  source: ReadableStream<Uint8Array>,
  digest: string,
  size: number,
  lifetimeMs: number,
  finished: () => void,
  offset = 0,
) {
  const reader = source.getReader();
  const hash = createHash("sha256");
  let received = 0;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    closeReader(reader);
    finished();
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        finish();
        controller.error(upstreamFailure());
      }, lifetimeMs);
      timer.unref?.();
    },
    async pull(controller) {
      try {
        const part = await reader.read();
        if (done) return;
        if (part.done) {
          if (received !== size || `sha256:${hash.digest("hex")}` !== digest) {
            throw upstreamFailure();
          }
          await finish();
          controller.close();
          return;
        }
        received += part.value.byteLength;
        if (received > size) throw upstreamFailure();
        hash.update(part.value);
        const start = Math.max(0, offset - (received - part.value.byteLength));
        if (start < part.value.byteLength) controller.enqueue(part.value.subarray(start));
      } catch {
        await finish();
        controller.error(upstreamFailure());
      }
    },
    cancel: finish,
  });
}

function closeReader(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "releaseLock">,
) {
  // Cleanup cannot let an unresponsive upstream retain a download slot.
  void reader.cancel().catch(() => logger.warn("Could not cancel Spack material upstream"));
  reader.releaseLock();
}
