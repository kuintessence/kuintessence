// three-tier namespace resolver + RBAC for the Registry
// artifact registry.
//
// Path forms accepted by the OCI v2 routes and the buildcache routes:
//   /v2/public/<repo>/...
//   /v2/org/<orgId>/<repo>/...
//   /v2/user/<userId>/<repo>/...
//
// The repository segment may itself contain '/'; the resolver greedy-
// matches the namespace prefix first.

import { DEFAULT_REGISTRY_PUBLISHER_ROLES, type RegistryRole } from "@kuintessence/shared";

export type { RegistryRole } from "@kuintessence/shared";

export type NamespaceKind = "public" | "org" | "user";

export interface ParsedNamespace {
  kind: NamespaceKind;
  owner: string | null; // null only when kind === 'public'
  name: string; // remaining repo name
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,253}$/;

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class NamespaceParseError extends Error {
  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`namespace parse error for "${path}": ${reason}`);
    this.name = "NamespaceParseError";
  }
}

export class NamespacePermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespacePermissionError";
  }
}

/**
 * Parse the OCI repository name component (the path portion BEFORE any
 * "/manifests/" or "/blobs/"). Pass the full v2 sub-path; return parsed
 * namespace + the bare repository name.
 *
 * Examples:
 *   parseNamespace('public/gromacs')              -> { kind: 'public', owner: null, name: 'gromacs' }
 *   parseNamespace('org/o-123/our-app')           -> { kind: 'org', owner: 'o-123', name: 'our-app' }
 *   parseNamespace('user/u-456/scratch/v1')       -> { kind: 'user', owner: 'u-456', name: 'scratch/v1' }
 */
export function parseNamespace(path: string): ParsedNamespace {
  if (!path) throw new NamespaceParseError(path, "empty path");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) throw new NamespaceParseError(path, "no segments");
  const head = parts[0];
  if (head !== "public" && head !== "org" && head !== "user") {
    throw new NamespaceParseError(path, `unknown namespace kind: ${head}`);
  }
  if (head === "public") {
    if (parts.length < 2)
      throw new NamespaceParseError(path, "public namespace requires a repo name");
    const firstSeg = parts[1];
    if (firstSeg === undefined)
      throw new NamespaceParseError(path, "public namespace missing repo segment");
    if (!NAME_RE.test(firstSeg)) throw new NamespaceParseError(path, "invalid repo name");
    return { kind: "public", owner: null, name: parts.slice(1).join("/") };
  }
  if (parts.length < 3)
    throw new NamespaceParseError(path, `${head} namespace requires owner + repo`);
  const owner = parts[1];
  const repoFirstSeg = parts[2];
  if (owner === undefined) throw new NamespaceParseError(path, `${head} namespace missing owner`);
  if (repoFirstSeg === undefined) throw new NamespaceParseError(path, "missing repo segment");
  if (!NAME_RE.test(repoFirstSeg)) throw new NamespaceParseError(path, "invalid repo name");
  return { kind: head, owner, name: parts.slice(2).join("/") };
}

export interface RbacPrincipal {
  sub: string;
  role: RegistryRole;
  orgIds: string[];
}

export type Operation = "read" | "write";
export const DEFAULT_PUBLISHER_ROLES = DEFAULT_REGISTRY_PUBLISHER_ROLES;

/**
 * RBAC matrix for the three-tier namespace.
 *
 *                | public          | org/<o>                 | user/<u>
 *   --------     | --------        | --------                | --------
 *   read         | any auth user   | members of <o>          | sub === <u>, or super_admin
 *   write        | platform_admin+ | org_admin of <o>+, or   | sub === <u>, or super_admin
 *                |                 | platform_admin+         |
 *
 * `super_admin` always passes.
 */
export function checkNamespaceAccess(
  principal: RbacPrincipal,
  ns: ParsedNamespace,
  op: Operation,
  publisherRoles: RegistryRole[] = DEFAULT_PUBLISHER_ROLES,
): void {
  if (op === "write") assertPublisherRole(principal, publisherRoles);
  if (principal.role === "super_admin") return;

  if (ns.kind === "public") {
    if (op === "read") return;
    if (principal.role === "platform_admin") return;
    throw new NamespacePermissionError(
      `${principal.sub} cannot ${op} public; requires platform_admin+`,
    );
  }

  if (ns.kind === "org") {
    if (!ns.owner) throw new NamespacePermissionError("org namespace missing owner");
    const isMember = principal.orgIds.includes(ns.owner);
    if (op === "read") {
      if (isMember) return;
      throw new NamespacePermissionError(`${principal.sub} not a member of org ${ns.owner}`);
    }
    // write
    if (principal.role === "platform_admin") return;
    if (principal.role === "org_admin" && isMember) return;
    throw new NamespacePermissionError(
      `${principal.sub} cannot write to org/${ns.owner}; requires org_admin in that org`,
    );
  }

  // user namespace
  if (ns.kind === "user") {
    if (!ns.owner) throw new NamespacePermissionError("user namespace missing owner");
    if (principal.sub === ns.owner) return;
    throw new NamespacePermissionError(
      `${principal.sub} cannot ${op} user/${ns.owner}; only the owner can access`,
    );
  }
}

export function assertPublisherRole(
  principal: RbacPrincipal,
  publisherRoles: RegistryRole[] = DEFAULT_PUBLISHER_ROLES,
): void {
  if (publisherRoles.includes(principal.role)) return;
  throw new NamespacePermissionError(
    `${principal.sub} cannot publish Registry artifacts; requires publisher role`,
  );
}

/**
 * Validate that a tag string is a permitted form. We accept:
 *   - 'latest' (special, mutable)
 *   - semver tags like 'v1.2.3', '1.2.3', '1.2.3-rc.1', '1.2.3+build.5'
 * Anything else is rejected.
 */
export function validateTag(
  tag: string,
): { ok: true; mutable: boolean } | { ok: false; reason: string } {
  if (tag === "latest") return { ok: true, mutable: true };
  if (!SEMVER_RE.test(tag)) return { ok: false, reason: `tag '${tag}' is not semver` };
  return { ok: true, mutable: false };
}
