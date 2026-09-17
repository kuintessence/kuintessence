import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type RoleName =
  | "guest"
  | "user"
  | "org_admin"
  | "operator"
  | "platform_admin"
  | "super_admin";

interface Probe {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

interface ProbeResult {
  firstStatus: number;
  status: number;
  expectedStatus: number;
  attempts: number;
  response: unknown;
}

interface EvidenceFailure {
  check: string;
  expected: unknown;
  actual: unknown;
}

const apiBase = process.env.KQ_ROLE_SMOKE_API_BASE ?? "http://localhost:13000/api";
const outputPath = resolve(process.argv[2] ?? "temp/role-operations-smoke.json");
const now = new Date();
const from = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
const to = now.toISOString();

export const ROLE_NAMES: readonly RoleName[] = [
  "guest",
  "user",
  "org_admin",
  "operator",
  "platform_admin",
  "super_admin",
];
const probes: Probe[] = [
  { name: "capabilities", method: "GET", path: "/me/capabilities" },
  { name: "cpDashboard", method: "GET", path: "/cp/dashboard" },
  { name: "cpUsers", method: "GET", path: "/cp/users" },
  { name: "cpAgents", method: "GET", path: "/cp/agents" },
  { name: "cpSoftware", method: "GET", path: "/cp/software/overview" },
  { name: "cpAudit", method: "POST", path: "/cp/audit/search", body: { from, to, limit: 10 } },
  { name: "cpOperations", method: "GET", path: "/cp/software/operations" },
  { name: "auditLog", method: "GET", path: "/audit-log" },
  {
    name: "metering",
    method: "GET",
    path: `/metering/query?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&period=raw&grouping=org`,
  },
  { name: "workflows", method: "GET", path: "/workflows" },
  { name: "jobs", method: "GET", path: "/jobs" },
];

async function login(role: RoleName): Promise<string> {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `role-operations-${role}@e2e.test`, role }),
  });
  const body = (await response.json()) as { token?: string };
  if (!response.ok || !body.token) {
    throw new Error(`Dev login failed for ${role}: HTTP ${response.status}`);
  }
  return body.token;
}

export function expectedStatus(actor: "anonymous" | RoleName, probe: string): number {
  if (actor === "anonymous") return 401;
  if (probe === "capabilities") return 200;
  if (actor === "guest") return 403;
  const platformAdministrator = actor === "platform_admin" || actor === "super_admin";
  if (probe.startsWith("cp")) {
    return actor === "org_admin" || platformAdministrator ? 200 : 403;
  }
  if (probe === "auditLog") {
    return actor === "operator" || platformAdministrator ? 200 : 403;
  }
  return 200;
}

export function hasSmokeFailures(
  requestFailures: readonly unknown[],
  evidenceFailures: readonly unknown[],
): boolean {
  return requestFailures.length > 0 || evidenceFailures.length > 0;
}

async function responseSummary(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    const encoded = JSON.stringify(value);
    return encoded.length <= 2_000 ? value : { truncated: encoded.slice(0, 2_000) };
  } catch {
    return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}...`;
  }
}

async function runProbe(probe: Probe, token?: string): Promise<ProbeResult> {
  const response = await fetch(`${apiBase}${probe.path}`, {
    method: probe.method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
  });
  return {
    firstStatus: response.status,
    status: response.status,
    expectedStatus: 0,
    attempts: 1,
    response: await responseSummary(response),
  };
}

async function runExpectedProbe(
  actor: "anonymous" | RoleName,
  probe: Probe,
  token?: string,
): Promise<ProbeResult> {
  const expected = expectedStatus(actor, probe.name);
  let firstStatus: number | undefined;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await runProbe(probe, token);
    firstStatus ??= result.status;
    result.expectedStatus = expected;
    result.firstStatus = firstStatus;
    result.attempts = attempt;
    if (result.status === expected || result.status !== 403 || expected !== 200 || attempt === 8) {
      return result;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("Probe retry loop exited unexpectedly");
}

function getCapabilities(response: unknown): unknown {
  if (typeof response !== "object" || response === null || !("capabilities" in response)) {
    return undefined;
  }
  return response.capabilities;
}

function getReadinessMode(response: unknown): unknown {
  if (typeof response !== "object" || response === null || !("data" in response)) return undefined;
  const data = response.data;
  if (typeof data !== "object" || data === null || !("mode" in data)) return undefined;
  return data.mode;
}

async function main(): Promise<void> {
  const actors: Array<"anonymous" | RoleName> = ["anonymous", ...ROLE_NAMES];
  const tokens = new Map<RoleName, string>();
  for (const role of ROLE_NAMES) tokens.set(role, await login(role));

  const requests: Record<string, Record<string, ProbeResult>> = {};
  const failures: Array<{ actor: string; probe: string; expected: number; actual: number }> = [];
  for (const actor of actors) {
    const actorResults: Record<string, ProbeResult> = {};
    for (const probe of probes) {
      const result = await runExpectedProbe(
        actor,
        probe,
        actor === "anonymous" ? undefined : tokens.get(actor),
      );
      actorResults[probe.name] = result;
      if (result.status !== result.expectedStatus) {
        failures.push({
          actor,
          probe: probe.name,
          expected: result.expectedStatus,
          actual: result.status,
        });
      }
    }
    requests[actor] = actorResults;
  }

  const platformToken = tokens.get("platform_admin");
  if (!platformToken) throw new Error("Missing platform_admin token");
  const readiness = await runProbe(
    { name: "authzReadiness", method: "GET", path: "/admin/authz/readiness" },
    platformToken,
  );
  readiness.expectedStatus = 200;
  const evidenceFailures: EvidenceFailure[] = [];
  if (readiness.status !== readiness.expectedStatus) {
    evidenceFailures.push({
      check: "authzReadinessStatus",
      expected: readiness.expectedStatus,
      actual: readiness.status,
    });
  }
  const readinessMode = getReadinessMode(readiness.response);
  if (readinessMode !== "enforce") {
    evidenceFailures.push({ check: "authzMode", expected: "enforce", actual: readinessMode });
  }
  const guestCapabilities = getCapabilities(requests.guest?.capabilities?.response);
  const expectedGuestCapabilities = ["workspace.ecosystem.view"];
  if (JSON.stringify(guestCapabilities) !== JSON.stringify(expectedGuestCapabilities)) {
    evidenceFailures.push({
      check: "guestCapabilities",
      expected: expectedGuestCapabilities,
      actual: guestCapabilities,
    });
  }

  const report = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    apiBase,
    environmentEvidence: {
      authzMode: readinessMode,
      readiness,
    },
    contractEvidence: {
      guestCapabilities,
      expectedGuestCapabilities,
    },
    requests,
    summary: {
      roleProbes: actors.length * probes.length,
      evidenceChecks: 3,
      checks: actors.length * probes.length + 3,
      passed: actors.length * probes.length + 3 - failures.length - evidenceFailures.length,
      failed: failures.length + evidenceFailures.length,
      failures: [...failures, ...evidenceFailures],
    },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, ...report.summary }));
  if (hasSmokeFailures(failures, evidenceFailures)) process.exitCode = 1;
}

if (import.meta.main) await main();
