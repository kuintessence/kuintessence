export class FederationError extends Error {
  constructor(
    readonly code:
      | "INVALID_MESSAGE"
      | "UNTRUSTED_IDENTITY"
      | "AUTHORIZATION_EXPIRED"
      | "AGREEMENT_UNAVAILABLE"
      | "POLICY_DENIED"
      | "BUDGET_EXHAUSTED"
      | "ATTESTATION_BACKLOG"
      | "STORAGE_PRESSURE"
      | "OPERATION_CONFLICT"
      | "LEDGER_REQUIRED"
      | "ASSET_UNAVAILABLE"
      | "DATA_WAITING"
      | "CANCELLATION_REQUESTED",
  ) {
    super(code);
    this.name = "FederationError";
  }
}
