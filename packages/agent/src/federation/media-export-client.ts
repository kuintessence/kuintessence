import { create } from "@bufbuild/protobuf";
import {
  type FederationMediaExport,
  type FederationMediaExportLeaseRequest,
  FederationMediaExportLeaseRequestSchema,
  type FederationMediaExportLeaseResponse,
  type FederationMediaExportReport,
  FederationMediaExportReportSchema,
} from "@kuintessence/proto";
import {
  type FederationMediaExportBindingSchema,
  FederationMediaExportLeaseSchema,
  FederationMediaExportTaskSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { MediaAge } from "@kuintessence/shared/federation/media-age";
import type { AgentDataRoots } from "../data-market/local-data-security";
import { exportFederationMedia } from "../data-market/media-export";
import { FederationTransferSession, FederationTransferSlot } from "./transfer-session";

export interface FederationMediaExportConfig {
  agentId: string;
  mediaDirectory: string;
  ageDirectory: string;
  roots: AgentDataRoots;
}
export class FederationMediaExportClient {
  private readonly session: FederationTransferSession;
  private readonly age: MediaAge;
  private readonly bindings = new Map<
    string,
    ReturnType<typeof FederationMediaExportBindingSchema.parse>
  >();
  constructor(
    private readonly config: FederationMediaExportConfig,
    sendGrant: (request: FederationMediaExportLeaseRequest) => boolean,
    sendReport: (report: FederationMediaExportReport) => void,
    slot = new FederationTransferSlot(),
    private readonly runExport = exportFederationMedia,
  ) {
    this.age = new MediaAge(config.ageDirectory);
    this.session = new FederationTransferSession(
      (request) =>
        sendGrant(
          create(FederationMediaExportLeaseRequestSchema, {
            requestId: request.requestId,
            bindingJson: request.bindingJson,
          }),
        ),
      (report) => {
        const binding = this.bindings.get(report.generation);
        if (!binding) return;
        this.bindings.delete(report.generation);
        sendReport(
          create(FederationMediaExportReportSchema, {
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
  receive(response: FederationMediaExportLeaseResponse) {
    this.session.receive(response);
  }
  disconnect() {
    return this.session.disconnect();
  }
  start(command: FederationMediaExport): void {
    if (Buffer.byteLength(command.taskJson) > 512 * 1024) return;
    const parsed = (() => {
      try {
        return FederationMediaExportTaskSchema.safeParse(JSON.parse(command.taskJson));
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
    };
    this.bindings.set(binding.generation, binding);
    this.session.run(
      task.generation,
      task.expiresAt,
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const result = await this.runExport({
          ...this.config,
          task,
          age: this.age,
          signal,
          authorize: async (requestSignal) => {
            const response = await this.session.request(
              { requestId: crypto.randomUUID(), bindingJson: JSON.stringify(binding) },
              requestSignal,
            );
            const grant = FederationMediaExportLeaseSchema.parse(JSON.parse(response.grantJson));
            if (
              federationCanonicalJson({
                generation: grant.generation,
                packageId: grant.packageId,
                manifestDigest: grant.manifestDigest,
              }) !== federationCanonicalJson(binding) ||
              Date.parse(grant.expiresAt) !== Number(response.leaseExpiresAtUnixMs)
            )
              throw new Error("INVALID_GRANT");
            lease(response.leaseExpiresAtUnixMs);
          },
        });
        return { copiedJson: JSON.stringify({ ...result, state: "exported" }) };
      },
    );
  }
}
