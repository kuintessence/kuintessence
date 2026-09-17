export type IdentityFallbackSurface =
  | "jobs_workflows_ws"
  | "rest_principal"
  | "session_read"
  | "session_refresh"
  | "ssh_ws";

const surfaces: IdentityFallbackSurface[] = [
  "jobs_workflows_ws",
  "rest_principal",
  "session_read",
  "session_refresh",
  "ssh_ws",
];

const counts = new Map<IdentityFallbackSurface, number>();

export function recordIdentityFallback(surface: IdentityFallbackSurface): void {
  counts.set(surface, (counts.get(surface) ?? 0) + 1);
}

export function identityFallbackMetricLines(): string[] {
  return surfaces.map(
    (surface) =>
      `kq_server_identity_fallback_total{kind="non_uuid_sub_email_lookup",surface="${surface}"} ${counts.get(surface) ?? 0}`,
  );
}
