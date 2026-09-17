import type { PlatformCapability } from "@kuintessence/shared/browser";

export function canCreateWorkflow(
  local: boolean,
  capabilities: ReadonlySet<PlatformCapability>,
): boolean {
  return local || capabilities.has("workflow.submit");
}
