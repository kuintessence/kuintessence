import { create } from "@bufbuild/protobuf";
import {
  type FederationMediaImport,
  type FederationMediaImportGrantResponse,
  type FederationMediaImportKeyRequest,
  FederationMediaImportKeyRequestSchema,
  type FederationMediaImportReport,
  FederationMediaImportReportSchema,
} from "@kuintessence/proto";
import {
  type FederationMediaImportBindingSchema,
  FederationMediaImportGrantSchema,
  FederationMediaImportTaskSchema,
  FederationMediaRecipientKeySchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import type { AgentDataRoots } from "../data-market/local-data-security";
import { importFederationMedia } from "../data-market/media-import";
import { FederationTransferSession, FederationTransferSlot } from "./transfer-session";

export interface FederationMediaImportConfig {
  agentId: string;
  mediaDirectory: string;
  ageDirectory: string;
  roots: AgentDataRoots;
}
export class FederationMediaImportClient {
  private readonly session: FederationTransferSession;
  private readonly age: MediaAge;
  private readonly bindings = new Map<
    string,
    ReturnType<typeof FederationMediaImportBindingSchema.parse>
  >();
  constructor(
    private readonly config: FederationMediaImportConfig,
    sendGrant: (request: FederationMediaImportKeyRequest) => boolean,
    sendReport: (report: FederationMediaImportReport) => void,
    slot = new FederationTransferSlot(),
    private readonly runImport = importFederationMedia,
  ) {
    this.age = new MediaAge(config.ageDirectory);
    this.session = new FederationTransferSession(
      (request) =>
        sendGrant(
          create(FederationMediaImportKeyRequestSchema, {
            requestId: request.requestId,
            bindingJson: request.bindingJson,
          }),
        ),
      (report) => {
        const binding = this.bindings.get(report.generation);
        if (!binding) return;
        this.bindings.delete(report.generation);
        sendReport(
          create(FederationMediaImportReportSchema, {
            reportJson: report.failed
              ? JSON.stringify({ ...binding, state: "failed" })
              : report.copiedJson,
          }),
        );
      },
      slot,
    );
  }
  hasPending(id: string) {
    return this.session.hasPending(id);
  }
  receive(response: FederationMediaImportGrantResponse) {
    this.session.receive(response);
  }
  disconnect() {
    return this.session.disconnect();
  }
  start(command: FederationMediaImport): void {
    if (Buffer.byteLength(command.taskJson) > 512 * 1024) return;
    const parsed = (() => {
      try {
        return FederationMediaImportTaskSchema.safeParse(JSON.parse(command.taskJson));
      } catch {
        return undefined;
      }
    })();
    if (!parsed?.success || parsed.data.agentId !== this.config.agentId) return;
    const task = parsed.data;
    const binding = {
      generation: task.generation,
      packageId: task.packageId,
      manifestDigest: task.manifestDigest,
      authorizationId: task.authorizationId,
    };
    this.bindings.set(binding.generation, binding);
    this.session.run(
      task.generation,
      task.expiresAt,
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
        const result = await this.runImport({
          privateKey: keys.privateKey,
          recipientKey,
          ...this.config,
          task,
          age: this.age,
          signal,
          authorize: async (requestSignal) => {
            const response = await this.session.request(
              {
                requestId: crypto.randomUUID(),
                bindingJson: JSON.stringify({ ...binding, recipientKey }),
              },
              requestSignal,
            );
            const grant = FederationMediaImportGrantSchema.parse(JSON.parse(response.grantJson));
            if (
              federationCanonicalJson(grant.binding) !== federationCanonicalJson(binding) ||
              Date.parse(grant.expiresAt) !== Number(response.leaseExpiresAtUnixMs)
            )
              throw new Error("INVALID_GRANT");
            lease(response.leaseExpiresAtUnixMs);
            return grant;
          },
        });
        return { copiedJson: JSON.stringify(result) };
      },
    );
  }
}
