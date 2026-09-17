import { AppError, ErrorCode } from "@kuintessence/shared";

export const CP_GOVERNANCE_WRITE_DISABLED_MESSAGE =
  "Compute-provider user governance writes are disabled pending organization-scoped governance.";

export function rejectLegacyCpGovernanceWrite(): never {
  throw new AppError(
    ErrorCode.CP_GOVERNANCE_WRITE_DISABLED,
    CP_GOVERNANCE_WRITE_DISABLED_MESSAGE,
    503,
  );
}

export function isLegacyCpGovernanceWrite(method: string, path: string): boolean {
  const routePath = path.replace(/^\/api\/cp(?=\/|$)/, "");
  return method === "POST" && /^\/users\/[^/]+\/(?:suspend|quota)$/.test(routePath);
}
