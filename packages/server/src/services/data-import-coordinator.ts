export type DataImportLifecycle =
  | "draft"
  | "scanning"
  | "validating"
  | "reviewing"
  | "ready"
  | "failed";

export interface DataImportScanRequest {
  importId: string;
  assetId: string;
  versionId: string;
  agentId: string;
  managedRootId: string;
  relativePath: string;
  providerOrgId: string;
}

export interface PersistedDataScanRequest extends DataImportScanRequest {
  requestId: string;
  deadlineAt: Date;
  attempt: number;
  status: "pending" | "completed" | "failed";
}

export interface DataImportScanAttestation {
  requestId: string;
  importId: string;
  agentId: string;
  manifestDigest: string;
  contentHash: string;
  sizeBytes: number;
  format: string;
  entries: Array<{ path: string; digest: string; sizeBytes: number; mediaType?: string }>;
  scannedAt: Date;
  providerOrgId: string;
  managedRootId: string;
  relativePath: string;
  attestationPayload: string;
  attestationSignature: string;
}

export interface DataImportCoordinator {
  requestCpLocalScan(
    input: DataImportScanRequest & { requestId: string; deadlineAt: Date },
  ): Promise<{ request: PersistedDataScanRequest; created: boolean }>;
  listPendingCpLocalScans(): Promise<PersistedDataScanRequest[]>;
  getCpLocalScan(requestId: string): Promise<PersistedDataScanRequest | null>;
  markCpLocalScanAttempt(requestId: string, dispatched: boolean): Promise<void>;
  acceptCpLocalScanAttestation(input: DataImportScanAttestation): Promise<void>;
  failCpLocalScan(input: {
    requestId: string;
    importId: string;
    error: string;
    completedAt: Date;
  }): Promise<void>;
}
