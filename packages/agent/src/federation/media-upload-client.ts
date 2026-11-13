import { create } from "@bufbuild/protobuf";
import {
  type FederationInputCopyReport,
  FederationInputCopyReportSchema,
  type FederationInputGrantRequest,
  FederationInputGrantRequestSchema,
  type FederationInputGrantResponse,
  type FederationMediaImportGrantResponse,
  type FederationMediaImportKeyRequest,
  FederationMediaImportKeyRequestSchema,
  type FederationMediaUpload,
  type FederationResultCopyReport,
  FederationResultCopyReportSchema,
  type FederationResultGrantRequest,
  FederationResultGrantRequestSchema,
  type FederationResultGrantResponse,
} from "@kuintessence/proto";
import {
  FederationInputCopyGrantSchema,
  FederationMediaImportGrantSchema,
  FederationMediaRecipientKeySchema,
  FederationMediaUploadTaskSchema,
  FederationResultCopyGrantSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import type { AgentDataRoots } from "../data-market/local-data-security";
import { uploadFederationMediaFile } from "./media-upload";
import { FederationTransferSession, FederationTransferSlot } from "./transfer-session";

type Channel = "media" | "input" | "result";
type Direction = "task-input" | "task-result";
interface MediaUploadConfig {
  agentId: string;
  roots: AgentDataRoots;
  inputOrigins?: readonly string[];
  resultOrigins?: readonly string[];
}
interface MediaUploadMessages {
  media(request: FederationMediaImportKeyRequest): boolean;
  input(request: FederationInputGrantRequest): boolean;
  result(request: FederationResultGrantRequest): boolean;
  inputReport(report: FederationInputCopyReport): void;
  resultReport(report: FederationResultCopyReport): void;
}

/** Upload and independent verification share the original transfer reports and Agent slot. */
export class FederationMediaUploadClient {
  private readonly session: FederationTransferSession;
  private readonly channels = new Map<string, Channel>();
  private readonly directions = new Map<string, Direction>();
  constructor(
    private readonly config: MediaUploadConfig,
    messages: MediaUploadMessages,
    slot = new FederationTransferSlot(),
    private readonly upload = uploadFederationMediaFile,
  ) {
    this.session = new FederationTransferSession(
      (request) => {
        const channel = this.channels.get(request.requestId);
        if (channel === "media")
          return messages.media(create(FederationMediaImportKeyRequestSchema, request));
        if (channel === "input")
          return messages.input(create(FederationInputGrantRequestSchema, request));
        if (channel === "result")
          return messages.result(create(FederationResultGrantRequestSchema, request));
        return false;
      },
      (report) => {
        const direction = this.directions.get(report.generation);
        this.directions.delete(report.generation);
        if (direction === "task-input")
          messages.inputReport(create(FederationInputCopyReportSchema, report));
        else if (direction === "task-result")
          messages.resultReport(create(FederationResultCopyReportSchema, report));
      },
      slot,
    );
  }
  hasPending(channel: Channel, id: string) {
    return this.channels.get(id) === channel && this.session.hasPending(id);
  }
  receive(
    channel: Channel,
    response:
      | FederationMediaImportGrantResponse
      | FederationInputGrantResponse
      | FederationResultGrantResponse,
  ) {
    if (this.hasPending(channel, response.requestId)) this.session.receive(response);
  }
  disconnect() {
    return this.session.disconnect();
  }
  private async request(
    channel: Channel,
    binding: unknown,
    signal: AbortSignal,
    partNumber?: number,
  ) {
    const requestId = crypto.randomUUID();
    this.channels.set(requestId, channel);
    try {
      return await this.session.request(
        {
          requestId,
          bindingJson: JSON.stringify(binding),
          ...(channel === "media" ? {} : { upload: true, partNumber }),
        },
        signal,
      );
    } finally {
      this.channels.delete(requestId);
    }
  }
  start(command: FederationMediaUpload) {
    if (Buffer.byteLength(command.taskJson) > 512 * 1024) return;
    let task: ReturnType<typeof FederationMediaUploadTaskSchema.parse>;
    try {
      task = FederationMediaUploadTaskSchema.parse(JSON.parse(command.taskJson));
    } catch {
      return;
    }
    if (task.media.agentId !== this.config.agentId) return;
    const { media, target } = task;
    const generation = target.binding.generation;
    const origins =
      target.kind === "task-input" ? this.config.inputOrigins : this.config.resultOrigins;
    if (!origins?.length || this.directions.has(generation)) return;
    this.directions.set(generation, target.kind);
    const binding = {
      generation: media.generation,
      packageId: media.packageId,
      manifestDigest: media.manifestDigest,
      authorizationId: media.authorizationId,
    };
    this.session.run(
      generation,
      new Date(
        Math.min(Date.parse(media.expiresAt), Date.parse(target.availableUntil)),
      ).toISOString(),
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const keys = await crypto.subtle.generateKey(
          {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          false,
          ["encrypt", "decrypt"],
        );
        signal.throwIfAborted();
        const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
        const recipientKey = FederationMediaRecipientKeySchema.parse({
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
        });
        let sourceUntil = 0;
        let destinationUntil = Number(command.leaseExpiresAtUnixMs);
        const uploadGrant = async (partNumber: number, requestSignal: AbortSignal) => {
          const response = await this.request(
            target.kind === "task-input" ? "input" : "result",
            target.binding,
            requestSignal,
            partNumber,
          );
          const schema =
            target.kind === "task-input"
              ? FederationInputCopyGrantSchema
              : FederationResultCopyGrantSchema;
          const grant = schema.parse(JSON.parse(response.grantJson));
          const deadline = Number(response.leaseExpiresAtUnixMs);
          if (
            federationCanonicalJson(grant.binding) !== federationCanonicalJson(target.binding) ||
            grant.direction !== "upload" ||
            grant.partNumber !== partNumber ||
            Date.parse(grant.expiresAt) > Math.min(deadline, sourceUntil) ||
            Date.parse(grant.expiresAt) <= Date.now()
          )
            throw new Error("INVALID_GRANT");
          destinationUntil = deadline;
          lease(BigInt(Math.min(sourceUntil, destinationUntil)));
          return grant;
        };
        const result = await this.upload({
          task,
          agentId: this.config.agentId,
          roots: this.config.roots,
          recipientKey,
          signal,
          allowedDestinationOrigins: origins,
          authorizeMedia: async (requestSignal) => {
            const response = await this.request(
              "media",
              { ...binding, recipientKey, purpose: "task-upload" },
              requestSignal,
            );
            const grant = FederationMediaImportGrantSchema.parse(JSON.parse(response.grantJson));
            if (
              federationCanonicalJson(grant.binding) !== federationCanonicalJson(binding) ||
              Date.parse(grant.expiresAt) !== Number(response.leaseExpiresAtUnixMs)
            )
              throw new Error("INVALID_GRANT");
            sourceUntil = Date.parse(grant.expiresAt);
            lease(BigInt(Math.min(sourceUntil, destinationUntil)));
            // Source refresh also renews the target while hashing a large private file.
            await uploadGrant(1, requestSignal);
            return grant;
          },
          authorizeUpload: async (_target, partNumber, requestSignal) =>
            uploadGrant(partNumber, requestSignal),
        });
        return { copiedJson: JSON.stringify(result.copied) };
      },
    );
  }
}
