import {
  hasRole,
  type PlatformCapability,
  Role,
  type RoleName,
} from "@kuintessence/shared/browser";
import {
  Activity,
  Box,
  Boxes,
  Building2,
  Code2,
  Database,
  FolderTree,
  Gauge,
  GitBranch,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Library,
  ListTodo,
  type LucideIcon,
  Monitor,
  Network,
  RadioTower,
  ReceiptText,
  ScrollText,
  Server,
  ShieldCheck,
  TerminalSquare,
  UserRound,
  UsersRound,
  Wrench,
} from "lucide-react";
import type { LocalCapabilities } from "../lib/local-mode";
import { resolveSoftwareSection, SOFTWARE_SECTION_HASH } from "../lib/software-navigation";

export type WorkspaceRoute =
  | "/"
  | "/jobs"
  | "/workflows"
  | "/terminal"
  | "/files"
  | "/data-market"
  | "/agents"
  | "/software"
  | "/cp"
  | "/cp/infrastructure"
  | "/cp/software"
  | "/cp/queues"
  | "/cp/users"
  | "/cp/accounts"
  | "/cp/audit"
  | "/cp/agents"
  | "/cp/agent-registration"
  | "/cp/metering"
  | "/cp/data"
  | "/operations"
  | "/settings";

export type WorkspaceDomainId = "consumer" | "provider" | "platform" | "ecosystem" | "personal";

export type WorkspaceIdentityId =
  | "consumer"
  | "provider-operations"
  | "provider-technical"
  | "platform-operations"
  | "platform-audit"
  | "platform-technical"
  | "software-developer"
  | "personal";

export interface WorkspaceNavItem {
  to: WorkspaceRoute;
  hash?: string;
  exact?: boolean;
  labelKey: string;
  icon: LucideIcon;
  requires?: RoleName;
  localCapability?: keyof LocalCapabilities;
  serverOnly?: boolean;
  serverCapability?: PlatformCapability;
}

export interface WorkspaceNavSection {
  labelKey: string;
  items: ReadonlyArray<WorkspaceNavItem>;
}

export interface WorkspaceIdentity {
  id: WorkspaceIdentityId;
  domain: WorkspaceDomainId;
  labelKey: string;
  shortLabelKey: string;
  descriptionKey: string;
  icon: LucideIcon;
  entry: { to: WorkspaceRoute; hash?: string };
  requires?: RoleName;
  serverOnly?: boolean;
  serverCapability?: PlatformCapability;
  sections: ReadonlyArray<WorkspaceNavSection>;
}

export interface WorkspaceDomain {
  id: WorkspaceDomainId;
  labelKey: string;
  icon: LucideIcon;
}

export const WORKSPACE_DOMAINS: ReadonlyArray<WorkspaceDomain> = [
  { id: "consumer", labelKey: "workspace.domain.consumer", icon: LayoutDashboard },
  { id: "provider", labelKey: "workspace.domain.provider", icon: Building2 },
  { id: "platform", labelKey: "workspace.domain.platform", icon: RadioTower },
  { id: "ecosystem", labelKey: "workspace.domain.ecosystem", icon: Boxes },
  { id: "personal", labelKey: "workspace.domain.personal", icon: UserRound },
];

export const WORKSPACE_IDENTITIES: ReadonlyArray<WorkspaceIdentity> = [
  {
    id: "consumer",
    domain: "consumer",
    labelKey: "workspace.identity.consumer",
    shortLabelKey: "workspace.identityShort.consumer",
    descriptionKey: "workspace.identityDescription.consumer",
    icon: LayoutDashboard,
    entry: { to: "/" },
    serverCapability: "workspace.consumer.access",
    sections: [
      {
        labelKey: "workspace.section.work",
        items: [
          { to: "/", labelKey: "nav.dashboard", icon: Gauge },
          { to: "/jobs", labelKey: "nav.jobs", icon: ListTodo },
          {
            to: "/workflows",
            labelKey: "nav.workflows",
            icon: GitBranch,
            localCapability: "workflows",
          },
          {
            to: "/terminal",
            labelKey: "nav.terminal",
            icon: TerminalSquare,
            requires: Role.ORG_ADMIN,
            serverOnly: true,
            serverCapability: "terminal.open",
          },
        ],
      },
      {
        labelKey: "workspace.section.resources",
        items: [
          { to: "/files", labelKey: "nav.files", icon: FolderTree, serverOnly: true },
          { to: "/data-market", labelKey: "nav.dataMarket", icon: Database, serverOnly: true },
          { to: "/agents", labelKey: "nav.agents", icon: Server, localCapability: "agents" },
        ],
      },
    ],
  },
  {
    id: "provider-operations",
    domain: "provider",
    labelKey: "workspace.identity.providerOperations",
    shortLabelKey: "workspace.identityShort.operations",
    descriptionKey: "workspace.identityDescription.providerOperations",
    icon: Activity,
    entry: { to: "/cp" },
    requires: Role.ORG_ADMIN,
    serverOnly: true,
    serverCapability: "workspace.provider.view",
    sections: [
      {
        labelKey: "workspace.section.operations",
        items: [
          { to: "/cp", exact: true, labelKey: "cp.nav.dashboard", icon: Gauge },
          { to: "/cp/metering", labelKey: "cp.nav.metering", icon: ReceiptText },
          {
            to: "/cp/data",
            labelKey: "cp.nav.data",
            icon: Database,
            serverCapability: "workspace.provider.manage",
          },
          {
            to: "/cp/software",
            labelKey: "cp.nav.software",
            icon: Box,
          },
        ],
      },
      {
        labelKey: "workspace.section.governance",
        items: [
          {
            to: "/cp/users",
            labelKey: "cp.nav.users",
            icon: UsersRound,
            serverCapability: "workspace.provider.manage",
          },
          {
            to: "/cp/accounts",
            labelKey: "cp.nav.accounts",
            icon: KeyRound,
            serverCapability: "workspace.provider.manage",
          },
          { to: "/cp/audit", labelKey: "cp.nav.audit", icon: ScrollText },
        ],
      },
    ],
  },
  {
    id: "provider-technical",
    domain: "provider",
    labelKey: "workspace.identity.providerTechnical",
    shortLabelKey: "workspace.identityShort.technical",
    descriptionKey: "workspace.identityDescription.providerTechnical",
    icon: Wrench,
    entry: { to: "/cp/infrastructure" },
    requires: Role.ORG_ADMIN,
    serverOnly: true,
    serverCapability: "workspace.provider.manage",
    sections: [
      {
        labelKey: "workspace.section.infrastructure",
        items: [
          { to: "/cp/infrastructure", labelKey: "cp.nav.infrastructure", icon: HardDrive },
          { to: "/cp/agents", labelKey: "cp.nav.agents", icon: Server },
          {
            to: "/cp/agent-registration",
            labelKey: "cp.nav.agentRegistration",
            icon: Network,
          },
        ],
      },
      {
        labelKey: "workspace.section.scheduling",
        items: [{ to: "/cp/queues", labelKey: "cp.nav.queues", icon: Library }],
      },
    ],
  },
  {
    id: "platform-operations",
    domain: "platform",
    labelKey: "workspace.identity.platformOperations",
    shortLabelKey: "workspace.identityShort.operations",
    descriptionKey: "workspace.identityDescription.platformOperations",
    icon: Activity,
    entry: { to: "/operations" },
    requires: Role.OPERATOR,
    serverOnly: true,
    serverCapability: "workspace.platform.view",
    sections: [
      {
        labelKey: "workspace.section.platformOperations",
        items: [
          {
            to: "/operations",
            hash: "overview",
            exact: true,
            labelKey: "workspace.nav.operationsOverview",
            icon: RadioTower,
          },
        ],
      },
    ],
  },
  {
    id: "platform-audit",
    domain: "platform",
    labelKey: "workspace.identity.platformAudit",
    shortLabelKey: "workspace.identityShort.audit",
    descriptionKey: "workspace.identityDescription.platformAudit",
    icon: ScrollText,
    entry: { to: "/operations", hash: "audit" },
    serverOnly: true,
    serverCapability: "workspace.audit.view",
    sections: [
      {
        labelKey: "workspace.section.audit",
        items: [
          {
            to: "/operations",
            hash: "audit",
            labelKey: "settings.operations.link.audit.title",
            icon: ScrollText,
            serverCapability: "audit.view",
          },
          {
            to: "/operations",
            hash: "metering",
            labelKey: "settings.operations.link.metering.title",
            icon: ReceiptText,
            serverCapability: "metering.report.view",
          },
        ],
      },
    ],
  },
  {
    id: "platform-technical",
    domain: "platform",
    labelKey: "workspace.identity.platformTechnical",
    shortLabelKey: "workspace.identityShort.technical",
    descriptionKey: "workspace.identityDescription.platformTechnical",
    icon: ShieldCheck,
    entry: { to: "/settings", hash: "security" },
    requires: Role.PLATFORM_ADMIN,
    serverOnly: true,
    serverCapability: "workspace.platform.manage",
    sections: [
      {
        labelKey: "workspace.section.platformTechnical",
        items: [
          {
            to: "/settings",
            hash: "security",
            labelKey: "settings.tabs.security",
            icon: ShieldCheck,
          },
          {
            to: "/settings",
            hash: "infrastructure",
            labelKey: "settings.tabs.infrastructure",
            icon: HardDrive,
          },
        ],
      },
    ],
  },
  {
    id: "software-developer",
    domain: "ecosystem",
    labelKey: "workspace.identity.softwareDeveloper",
    shortLabelKey: "workspace.identityShort.developer",
    descriptionKey: "workspace.identityDescription.softwareDeveloper",
    icon: Code2,
    entry: { to: "/software" },
    serverCapability: "workspace.ecosystem.view",
    sections: [
      {
        labelKey: "workspace.section.softwareAssets",
        items: [
          {
            to: "/software",
            hash: "workflow-templates",
            labelKey: "software.tabs.templates",
            icon: GitBranch,
          },
          { to: "/software", hash: "usecases", labelKey: "software.tabs.usecases", icon: Box },
          { to: "/software", hash: "spack", labelKey: "software.tabs.spack", icon: Boxes },
          {
            to: "/software",
            hash: "scripts",
            labelKey: "software.tabs.scripts",
            icon: Code2,
          },
        ],
      },
    ],
  },
  {
    id: "personal",
    domain: "personal",
    labelKey: "workspace.identity.personal",
    shortLabelKey: "workspace.identityShort.personal",
    descriptionKey: "workspace.identityDescription.personal",
    icon: UserRound,
    entry: { to: "/settings", hash: "personal/account" },
    serverCapability: "workspace.personal.access",
    sections: [
      {
        labelKey: "workspace.section.personal",
        items: [
          {
            to: "/settings",
            hash: "personal/account",
            labelKey: "settings.personalNav.account",
            icon: UserRound,
          },
          {
            to: "/settings",
            hash: "personal/execution-accounts",
            labelKey: "settings.personalNav.executionAccounts",
            icon: KeyRound,
          },
          {
            to: "/settings",
            hash: "personal/appearance",
            labelKey: "settings.personalNav.appearance",
            icon: Monitor,
          },
        ],
      },
    ],
  },
];

export function canUseWorkspaceIdentity(
  identity: WorkspaceIdentity,
  role: string | null,
  local: boolean,
  capabilities: LocalCapabilities | null,
  serverCapabilities?: ReadonlySet<PlatformCapability>,
): boolean {
  if (local && identity.serverOnly) return false;
  if (!local && identity.serverCapability && serverCapabilities) {
    return serverCapabilities.has(identity.serverCapability);
  }
  if (identity.requires && (!role || !hasRole(role as RoleName, identity.requires))) return false;
  if (identity.id === "software-developer" && local && !capabilities?.software) return false;
  return true;
}

export function canUseWorkspaceNavItem(
  item: WorkspaceNavItem,
  role: string | null,
  local: boolean,
  capabilities: LocalCapabilities | null,
  serverCapabilities?: ReadonlySet<PlatformCapability>,
): boolean {
  if (local && item.serverOnly) return false;
  if (!local && item.serverCapability && serverCapabilities) {
    return serverCapabilities.has(item.serverCapability);
  }
  if (item.requires && (!role || !hasRole(role as RoleName, item.requires))) return false;
  if (local && item.localCapability && !capabilities?.[item.localCapability]) return false;
  return true;
}

const PROVIDER_TECHNICAL_PATHS = new Set([
  "/cp/infrastructure",
  "/cp/queues",
  "/cp/agents",
  "/cp/agent-registration",
]);

export function inferWorkspaceIdentity(pathname: string, hash: string): WorkspaceIdentityId {
  if (pathname === "/cp" || pathname.startsWith("/cp/")) {
    return PROVIDER_TECHNICAL_PATHS.has(pathname) ? "provider-technical" : "provider-operations";
  }
  if (pathname === "/operations" || pathname.startsWith("/operations/")) {
    const area = hash.replace(/^#/, "");
    if (area === "audit" || area === "metering") return "platform-audit";
    return "platform-operations";
  }
  if (pathname === "/software" || pathname.startsWith("/software/")) {
    return "software-developer";
  }
  if (pathname === "/settings") {
    const normalizedHash = hash.replace(/^#/, "").split("/")[0];
    if (normalizedHash === "security" || normalizedHash === "infrastructure") {
      return "platform-technical";
    }
    return "personal";
  }
  return "consumer";
}

export function isWorkspaceNavItemActive(
  item: WorkspaceNavItem,
  pathname: string,
  hash: string,
): boolean {
  const pathMatches =
    item.to === "/" || item.exact
      ? pathname === item.to
      : pathname === item.to || pathname.startsWith(`${item.to}/`);
  if (!pathMatches) return false;
  if (!item.hash) return true;
  if (item.to === "/software") {
    const section = resolveSoftwareSection(pathname, hash);
    return section !== null && SOFTWARE_SECTION_HASH[section] === item.hash;
  }
  const normalizedHash = hash.replace(/^#/, "");
  if (!normalizedHash) {
    return (
      (item.to === "/settings" && item.hash === "personal/account") ||
      (item.to === "/operations" && item.hash === "overview")
    );
  }
  if (item.hash.includes("/")) return normalizedHash === item.hash;
  return normalizedHash.split("/")[0] === item.hash;
}

export function getWorkspaceIdentity(id: WorkspaceIdentityId): WorkspaceIdentity {
  const identity = WORKSPACE_IDENTITIES.find((candidate) => candidate.id === id);
  if (!identity) throw new Error(`Unknown workspace identity: ${id}`);
  return identity;
}
