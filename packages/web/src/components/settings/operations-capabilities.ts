import type { PlatformCapability } from "@kuintessence/shared/browser";
import {
  BadgeDollarSign,
  ClipboardList,
  DatabaseZap,
  EyeOff,
  FileKey2,
  FolderTree,
  Gauge,
  HardDrive,
  KeyRound,
  type LucideIcon,
  Network,
  Palette,
  RadioTower,
  Route,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

export type OperationsArea = "security" | "compute" | "metering" | "audit" | "governance";
export type OperationsRequiredRole =
  | "user"
  | "org_admin"
  | "operator"
  | "platform_admin"
  | "super_admin";

export interface OperationsLink {
  key: string;
  area: OperationsArea;
  href: string;
  requiredRole: OperationsRequiredRole;
  alternativeRoles?: ReadonlyArray<OperationsRequiredRole>;
  requiredCapability?: PlatformCapability;
  icon: LucideIcon;
}

export const OPERATIONS_AREAS: ReadonlyArray<OperationsArea> = [
  "security",
  "compute",
  "metering",
  "audit",
  "governance",
];

export const OPERATIONS_LINKS: ReadonlyArray<OperationsLink> = [
  {
    key: "branding",
    area: "security",
    href: "/settings#security/branding",
    requiredRole: "platform_admin",
    icon: Palette,
  },
  {
    key: "authz",
    area: "security",
    href: "/settings#security/authz",
    requiredRole: "platform_admin",
    icon: ShieldAlert,
  },
  {
    key: "sso",
    area: "security",
    href: "/settings#security/sso",
    requiredRole: "platform_admin",
    icon: ShieldCheck,
  },
  {
    key: "desensitize",
    area: "security",
    href: "/settings#security/desensitize",
    requiredRole: "platform_admin",
    icon: EyeOff,
  },
  {
    key: "sshVault",
    area: "security",
    href: "/settings#security/ssh-vault",
    requiredRole: "platform_admin",
    icon: KeyRound,
  },
  {
    key: "agentCerts",
    area: "security",
    href: "/settings#security/agent-certs",
    requiredRole: "platform_admin",
    icon: FileKey2,
  },
  {
    key: "sshSessions",
    area: "security",
    href: "/settings#security/ssh-sessions",
    requiredRole: "platform_admin",
    icon: TerminalSquare,
  },
  {
    key: "sshRecordings",
    area: "security",
    href: "/settings#security/ssh-recordings",
    requiredRole: "platform_admin",
    icon: FileKey2,
  },
  {
    key: "metering",
    area: "metering",
    href: "/cp/metering",
    requiredRole: "org_admin",
    alternativeRoles: ["operator"],
    icon: BadgeDollarSign,
  },
  {
    key: "costRates",
    area: "metering",
    href: "/settings#infrastructure/cost-rates",
    requiredRole: "super_admin",
    icon: Gauge,
  },
  {
    key: "audit",
    area: "audit",
    href: "/operations#audit",
    requiredRole: "operator",
    requiredCapability: "audit.view",
    icon: ClipboardList,
  },
  {
    key: "cpAudit",
    area: "governance",
    href: "/cp/audit",
    requiredRole: "org_admin",
    icon: ClipboardList,
  },
  {
    key: "agents",
    area: "compute",
    href: "/agents",
    requiredRole: "user",
    icon: RadioTower,
  },
  {
    key: "cpAgents",
    area: "compute",
    href: "/cp/agents",
    requiredRole: "org_admin",
    icon: Network,
  },
  {
    key: "clusterFileRoots",
    area: "compute",
    href: "/settings#infrastructure/cluster-file-roots",
    requiredRole: "org_admin",
    icon: FolderTree,
  },
  {
    key: "softwarePolicy",
    area: "compute",
    href: "/cp/software",
    requiredRole: "org_admin",
    icon: DatabaseZap,
  },
  {
    key: "registry",
    area: "governance",
    href: "/software",
    requiredRole: "user",
    icon: HardDrive,
  },
  {
    key: "placement",
    area: "governance",
    href: "/jobs",
    requiredRole: "user",
    icon: Route,
  },
];

function normalizeRole(role: string | null): OperationsRequiredRole {
  return role === "org_admin" ||
    role === "operator" ||
    role === "platform_admin" ||
    role === "super_admin" ||
    role === "user"
    ? role
    : "user";
}

export function canAccessOperation(
  role: string | null,
  requiredRole: OperationsRequiredRole,
): boolean {
  const normalizedRole = normalizeRole(role);
  if (requiredRole === "user") return true;
  if (requiredRole === "org_admin") {
    return (
      normalizedRole === "org_admin" ||
      normalizedRole === "platform_admin" ||
      normalizedRole === "super_admin"
    );
  }
  if (requiredRole === "operator") {
    return (
      normalizedRole === "operator" ||
      normalizedRole === "platform_admin" ||
      normalizedRole === "super_admin"
    );
  }
  if (requiredRole === "platform_admin") {
    return normalizedRole === "platform_admin" || normalizedRole === "super_admin";
  }
  return normalizedRole === "super_admin";
}

export function canAccessOperationsLink(
  role: string | null,
  item: OperationsLink,
  capabilities?: ReadonlySet<PlatformCapability>,
): boolean {
  return (
    canAccessOperation(role, item.requiredRole) ||
    (item.alternativeRoles?.some((candidate) => canAccessOperation(role, candidate)) ?? false) ||
    (item.requiredCapability ? (capabilities?.has(item.requiredCapability) ?? false) : false)
  );
}

export function operationsHrefForRole(
  role: string | null,
  item: OperationsLink,
  capabilities?: ReadonlySet<PlatformCapability>,
): string {
  if (
    item.key === "metering" &&
    (role === "operator" ||
      (!canAccessOperation(role, "org_admin") &&
        (capabilities?.has("metering.report.view") ?? false)))
  ) {
    return "/operations#metering";
  }
  return item.href;
}
