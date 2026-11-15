import type { PlatformCapability } from "@kuintessence/shared/browser";
import type { LocalCapabilities } from "../../lib/local-mode";
import { canCreateWorkflow } from "../../lib/workflow-access";
import {
  canUseWorkspaceIdentity,
  canUseWorkspaceNavItem,
  WORKSPACE_IDENTITIES,
} from "../workspace-navigation";
import type { FunctionMap, MapNode } from "./model";

export interface MapAccess {
  role: string | null;
  local: boolean;
  localCapabilities: LocalCapabilities | null;
  platform: ReadonlySet<PlatformCapability>;
  federation: ReadonlySet<string>;
  ready: boolean;
}
const FEDERATION_READ: Record<string, string> = {
  tasks: "delegation.read",
  market: "market.read",
  agreements: "agreement.read",
  assets: "asset.read",
  commercial: "agreement.read",
  delivery: "asset.read",
  cases: "disclosure.receive",
  logistics: "media.logistics",
};
export function canSeeMapRoute(route: string, access: MapAccess): boolean {
  if (!access.ready) return false;
  const [path, hash = ""] = route.split("#");
  if (path === "/federation") {
    return !access.local && access.federation.has(FEDERATION_READ[hash] ?? "agreement.read");
  }
  if (path === "/settings" && /^(security|infrastructure)(\/|$)/.test(hash)) {
    return (
      !access.local &&
      access.platform.has("workspace.platform.manage") &&
      (access.role === "platform_admin" || access.role === "super_admin") &&
      (hash !== "infrastructure/cost-rates" || access.role === "super_admin")
    );
  }
  if (path === "/operations") {
    if (hash === "audit") return access.platform.has("audit.view");
    if (hash === "metering") return access.platform.has("metering.report.view");
    if (hash === "governance") return access.platform.has("workspace.platform.manage");
  }
  if (path === "/workflows/new" && !canCreateWorkflow(access.local, access.platform)) return false;
  return WORKSPACE_IDENTITIES.some(
    (identity) =>
      canUseWorkspaceIdentity(
        identity,
        access.role,
        access.local,
        access.localCapabilities,
        access.platform,
      ) &&
      identity.sections.some((section) =>
        section.items.some(
          (item) =>
            (item.to === path || (path === "/workflows/new" && item.to === "/workflows")) &&
            (!hash || !item.hash || hash === item.hash) &&
            canUseWorkspaceNavItem(
              item,
              access.role,
              access.local,
              access.localCapabilities,
              access.platform,
            ),
        ),
      ),
  );
}
export function visibleMap(model: FunctionMap, access: MapAccess): FunctionMap {
  const nodes = model.nodes.filter(
    (node) =>
      canSeeMapRoute(node.route, access) &&
      (!node.capability || access.federation.has(node.capability)),
  );
  const ids = new Set(nodes.map((node) => node.id));
  return {
    ...model,
    nodes,
    edges: model.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}
// Preserve scope parameters, never login tokens, paging, or IDs from an unrelated object.
export function mapDestination(node: MapNode, search: Record<string, unknown>) {
  const [to = "/", hash = ""] = node.route.split("#");
  const scope: Record<string, unknown> = {};
  for (const key of ["tenantId", "projectId", "region", "providerOrgId", "orgId"]) {
    if (typeof search[key] === "string") scope[key] = search[key];
  }
  return { to, hash, search: scope };
}
