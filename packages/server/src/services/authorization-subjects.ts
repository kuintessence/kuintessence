import type { AuthorizationSubjectId } from "@kuintessence/db";

export function canonicalAuthorizationSubject(kind: string, id: string): AuthorizationSubjectId {
  if (id.length === 0) throw new Error("Authorization subject id must not be empty");
  if (kind === "user") return `user:${id}`;
  if (kind === "org") return `organization:${id}`;
  throw new Error("Authorization subject kind is unsupported");
}

export function frozenAuthorizationSubjects(
  userId: string,
  organizationId: string | null,
): AuthorizationSubjectId[] {
  return [
    canonicalAuthorizationSubject("user", userId),
    ...(organizationId ? [canonicalAuthorizationSubject("org", organizationId)] : []),
  ];
}
