import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "./config";

const VALID_BASE = {
  DATABASE_URL: "postgres://kq:kq@localhost:5432/kuintessence",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
};

describe("Spack material delivery configuration", () => {
  const enabled = {
    ...VALID_BASE,
    SPACK_MATERIAL_DELIVERY_ENABLED: "true",
    SPACK_REGISTRY_URL: "http://registry:3100",
    SPACK_REGISTRY_ALLOW_INSECURE_HTTP: "true",
    SPACK_REGISTRY_JWT_SECRET: "registry".repeat(5),
    SPACK_MATERIAL_TICKET_SECRET: "ticket".repeat(6),
    MTLS_MODE: "direct",
  };
  test("is disabled by default and requires dedicated keys and mTLS when enabled", () => {
    expect(loadServerConfig(VALID_BASE).SPACK_MATERIAL_DELIVERY_ENABLED).toBe(false);
    expect(loadServerConfig(enabled).SPACK_MATERIAL_DELIVERY_ENABLED).toBe(true);
    for (const patch of [
      { MTLS_MODE: "off" },
      { SPACK_REGISTRY_URL: undefined },
      { SPACK_REGISTRY_JWT_SECRET: undefined },
      { SPACK_MATERIAL_TICKET_SECRET: undefined },
      { SPACK_MATERIAL_TICKET_SECRET: VALID_BASE.JWT_SECRET },
      { SPACK_MATERIAL_TICKET_SECRET: enabled.SPACK_REGISTRY_JWT_SECRET },
    ]) {
      expect(() => loadServerConfig({ ...enabled, ...patch })).toThrow();
    }
  });
  test("rejects Registry URLs carrying credentials, paths, or query arguments", () => {
    for (const url of [
      "https://user:secret@registry",
      "file:///tmp",
      "https://registry/prefix",
      "https://registry?token=secret",
    ]) {
      expect(() => loadServerConfig({ ...enabled, SPACK_REGISTRY_URL: url })).toThrow();
    }
  });
  test("requires explicit private-network opt-in for non-loopback plaintext Registry traffic", () => {
    expect(() =>
      loadServerConfig({ ...enabled, SPACK_REGISTRY_ALLOW_INSECURE_HTTP: "false" }),
    ).toThrow();
    expect(
      loadServerConfig({
        ...enabled,
        SPACK_REGISTRY_ALLOW_INSECURE_HTTP: "false",
        SPACK_REGISTRY_URL: "https://registry",
      }).SPACK_REGISTRY_URL,
    ).toBe("https://registry");
    expect(
      loadServerConfig({
        ...enabled,
        SPACK_REGISTRY_ALLOW_INSECURE_HTTP: "false",
        SPACK_REGISTRY_URL: "http://127.0.0.1:3100",
      }).SPACK_REGISTRY_URL,
    ).toBe("http://127.0.0.1:3100");
  });
  test("accepts exact spec mappings only with immutable repository and manifest digests", () => {
    const binding = { repositoryId: "a".repeat(64), manifestDigest: `sha256:${"b".repeat(64)}` };
    expect(
      loadServerConfig({
        ...enabled,
        SPACK_MATERIAL_RELEASES: JSON.stringify({ "zlib@1.3.1": binding }),
      }).SPACK_MATERIAL_RELEASES,
    ).toEqual({ "zlib@1.3.1": binding });
    expect(() => loadServerConfig({ ...enabled, SPACK_MATERIAL_RELEASES: "not json" })).toThrow();
    expect(() =>
      loadServerConfig({
        ...enabled,
        SPACK_MATERIAL_RELEASES: JSON.stringify({ zlib: { ...binding, manifestDigest: "latest" } }),
      }),
    ).toThrow();
  });
});

describe("loadServerConfig (mTLS additions)", () => {
  test("DB pool config defaults to postgres-js compatible values", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(10);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(0);
  });

  test("DB pool config honors operator overrides", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      DB_MAX_CONNECTIONS: "4",
      DB_IDLE_TIMEOUT_SEC: "30",
    } as NodeJS.ProcessEnv);
    expect(cfg.DB_MAX_CONNECTIONS).toBe(4);
    expect(cfg.DB_IDLE_TIMEOUT_SEC).toBe(30);
  });

  test("loads the Registry publisher role contract", () => {
    expect(
      loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["super_admin", "platform_admin", "org_admin"]);
    expect(
      loadServerConfig({
        ...VALID_BASE,
        REGISTRY_PUBLISHER_ROLES: "platform_admin,operator",
      } as NodeJS.ProcessEnv).REGISTRY_PUBLISHER_ROLES,
    ).toEqual(["platform_admin", "operator"]);
  });

  test("MTLS_REQUIRED defaults to false", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.MTLS_REQUIRED).toBe(false);
  });

  test("MTLS_REQUIRED parses 'true' to boolean", () => {
    const cfg = loadServerConfig({ ...VALID_BASE, MTLS_REQUIRED: "true" } as NodeJS.ProcessEnv);
    expect(cfg.MTLS_REQUIRED).toBe(true);
  });

  test("MTLS_REQUIRED parses case-insensitively", () => {
    const cfg = loadServerConfig({ ...VALID_BASE, MTLS_REQUIRED: "TRUE" } as NodeJS.ProcessEnv);
    expect(cfg.MTLS_REQUIRED).toBe(true);
  });

  test("MTLS_MODE accepts the production mode selector", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      MTLS_MODE: "trusted-proxy",
      MTLS_TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      MTLS_HEADER_FINGERPRINT: "x-client-cert-sha256",
    } as NodeJS.ProcessEnv);
    expect(cfg.MTLS_MODE).toBe("trusted-proxy");
    expect(cfg.MTLS_TRUSTED_PROXY_CIDRS).toBe("10.0.0.0/8");
    expect(cfg.MTLS_HEADER_FINGERPRINT).toBe("x-client-cert-sha256");
  });

  test("keeps HTTP proxy CIDRs separate from the mTLS proxy boundary", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      HTTP_TRUSTED_PROXY_CIDRS: "10.42.7.18/32,fd00:42::/64",
    } as NodeJS.ProcessEnv);
    expect(cfg.HTTP_TRUSTED_PROXY_CIDRS).toBe("10.42.7.18/32,fd00:42::/64");
  });

  test("direct mTLS preserves the HTTP/2 server certificate paths", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      MTLS_MODE: "direct",
      SERVER_GRPC_TLS_CERT_FILE: "/etc/kq/grpc.crt",
      SERVER_GRPC_TLS_KEY_FILE: "/etc/kq/grpc.key",
    } as NodeJS.ProcessEnv);
    expect(cfg.SERVER_GRPC_TLS_CERT_FILE).toBe("/etc/kq/grpc.crt");
    expect(cfg.SERVER_GRPC_TLS_KEY_FILE).toBe("/etc/kq/grpc.key");
  });

  test("WEB_CSP is optional but preserved when configured", () => {
    const policy = "default-src 'self'";
    const cfg = loadServerConfig({ ...VALID_BASE, WEB_CSP: policy } as NodeJS.ProcessEnv);
    expect(cfg.WEB_CSP).toBe(policy);
  });

  test("SERVER_CA_DIR defaults to ./server-ca", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.SERVER_CA_DIR).toBe("./server-ca");
  });

  test("SERVER_CA_DIR honors override", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      SERVER_CA_DIR: "/etc/kq/ca",
    } as NodeJS.ProcessEnv);
    expect(cfg.SERVER_CA_DIR).toBe("/etc/kq/ca");
  });
});

describe("NetDrive multipart config", () => {
  test("defaults part size 64 MiB, threshold 64 MiB, ttl 3600s", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.NETDRIVE_MULTIPART_PART_SIZE_MB).toBe(64);
    expect(cfg.NETDRIVE_MULTIPART_THRESHOLD_MB).toBe(64);
    expect(cfg.NETDRIVE_MULTIPART_TTL_SEC).toBe(3600);
  });

  test("rejects a part size below the 5 MiB S3 floor", () => {
    expect(() =>
      loadServerConfig({
        ...VALID_BASE,
        NETDRIVE_MULTIPART_PART_SIZE_MB: "4",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  test("requires a positive immutable Data Market retention period", () => {
    expect(
      loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).DATA_MARKET_IMMUTABLE_RETENTION_DAYS,
    ).toBe(365);
    expect(() =>
      loadServerConfig({
        ...VALID_BASE,
        DATA_MARKET_IMMUTABLE_RETENTION_DAYS: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATA_MARKET_IMMUTABLE_RETENTION_DAYS/);
  });
});

describe("workflow sync config", () => {
  test("defaults WORKFLOW_SYNC_ENABLED to false", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.WORKFLOW_SYNC_ENABLED).toBe(false);
  });

  test("parses WORKFLOW_SYNC_ENABLED as a boolean", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      WORKFLOW_SYNC_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    expect(cfg.WORKFLOW_SYNC_ENABLED).toBe(true);
  });
});

describe("Sandbox self-account config", () => {
  test("defaults disabled and accepts an explicit opt-in", () => {
    expect(
      loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv).SANDBOX_SELF_ACCOUNT_ENABLED,
    ).toBe(false);
    expect(
      loadServerConfig({
        ...VALID_BASE,
        SANDBOX_SELF_ACCOUNT_ENABLED: "true",
      } as NodeJS.ProcessEnv).SANDBOX_SELF_ACCOUNT_ENABLED,
    ).toBe(true);
  });
});

describe("cluster file static roots config", () => {
  test("defaults to no static roots", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.CLUSTER_FILE_STATIC_ROOTS).toEqual([]);
  });

  test("parses an explicit comma-separated development fallback", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      CLUSTER_FILE_STATIC_ROOTS: " /home, /scratch ,, /work ",
    } as NodeJS.ProcessEnv);
    expect(cfg.CLUSTER_FILE_STATIC_ROOTS).toEqual(["/home", "/scratch", "/work"]);
  });

  test("rejects relative and filesystem-wide static roots", () => {
    expect(() =>
      loadServerConfig({
        ...VALID_BASE,
        CLUSTER_FILE_STATIC_ROOTS: "/home, scratch, /",
      } as NodeJS.ProcessEnv),
    ).toThrow("CLUSTER_FILE_STATIC_ROOTS must contain absolute non-root paths");
  });
});

describe("scheduler queue-wait aggregation config", () => {
  test("defaults SCHEDULER_QUEUE_WAIT_AGG_SEC to 0 (disabled)", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.SCHEDULER_QUEUE_WAIT_AGG_SEC).toBe(0);
  });

  test("honors a positive SCHEDULER_QUEUE_WAIT_AGG_SEC override", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      SCHEDULER_QUEUE_WAIT_AGG_SEC: "300",
    } as NodeJS.ProcessEnv);
    expect(cfg.SCHEDULER_QUEUE_WAIT_AGG_SEC).toBe(300);
  });
});

describe("Agent heartbeat reconciliation config", () => {
  test("defaults to a 90 second timeout and 30 second sweep", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.AGENT_HEARTBEAT_TIMEOUT_SEC).toBe(90);
    expect(cfg.AGENT_HEARTBEAT_SWEEP_INTERVAL_SEC).toBe(30);
  });

  test("rejects non-positive heartbeat timeout and negative sweep intervals", () => {
    expect(() =>
      loadServerConfig({ ...VALID_BASE, AGENT_HEARTBEAT_TIMEOUT_SEC: "0" } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      loadServerConfig({
        ...VALID_BASE,
        AGENT_HEARTBEAT_SWEEP_INTERVAL_SEC: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("compute health config", () => {
  test("defaults to compatibility mode with bounded age and future clock skew", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.COMPUTE_HEALTH_ENFORCE).toBe(false);
    expect(cfg.COMPUTE_HEALTH_MAX_AGE_SEC).toBe(120);
    expect(cfg.COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC).toBe(5);
  });

  test("parses explicit enforcement and validates health time bounds", () => {
    const enforced = loadServerConfig({
      ...VALID_BASE,
      COMPUTE_HEALTH_ENFORCE: "true",
      COMPUTE_HEALTH_MAX_AGE_SEC: "30",
      COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC: "2",
    } as NodeJS.ProcessEnv);
    expect(enforced.COMPUTE_HEALTH_ENFORCE).toBe(true);
    expect(enforced.COMPUTE_HEALTH_MAX_AGE_SEC).toBe(30);
    expect(enforced.COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC).toBe(2);
    expect(
      loadServerConfig({
        ...VALID_BASE,
        COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC: "0",
      } as NodeJS.ProcessEnv).COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC,
    ).toBe(0);
    expect(() =>
      loadServerConfig({ ...VALID_BASE, COMPUTE_HEALTH_MAX_AGE_SEC: "0" } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      loadServerConfig({
        ...VALID_BASE,
        COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe("queue inventory config", () => {
  test("defaults to compatibility mode with bounded queue observations", () => {
    const cfg = loadServerConfig({ ...VALID_BASE } as NodeJS.ProcessEnv);
    expect(cfg.QUEUE_VALIDATION_MODE).toBe("off");
    expect(cfg.QUEUE_INVENTORY_MAX_AGE_SEC).toBe(120);
    expect(cfg.QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC).toBe(5);
  });

  test("accepts enforce mode and validates observation bounds", () => {
    const cfg = loadServerConfig({
      ...VALID_BASE,
      QUEUE_VALIDATION_MODE: "enforce",
      QUEUE_INVENTORY_MAX_AGE_SEC: "30",
      QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC: "0",
    } as NodeJS.ProcessEnv);
    expect(cfg.QUEUE_VALIDATION_MODE).toBe("enforce");
    expect(cfg.QUEUE_INVENTORY_MAX_AGE_SEC).toBe(30);
    expect(cfg.QUEUE_INVENTORY_MAX_FUTURE_SKEW_SEC).toBe(0);
    expect(() =>
      loadServerConfig({ ...VALID_BASE, QUEUE_INVENTORY_MAX_AGE_SEC: "0" } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
