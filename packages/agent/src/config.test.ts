import { describe, expect, test } from "bun:test";
import { loadAgentConfig } from "./config";

describe("loadAgentConfig", () => {
  const baseEnv = {
    SERVER_GRPC_URL: "http://localhost:3001",
    AGENT_ID: "agent-test",
    AGENT_SITE_NAME: "test-site",
  };

  test("loads valid config with defaults", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_ID).toBe("agent-test");
    expect(cfg.AGENT_DB_PATH).toBe("./agent.db");
    expect(cfg.HEARTBEAT_INTERVAL_SEC).toBe(30);
    expect(cfg.AGENT_GRPC_PING_INTERVAL_SEC).toBe(30);
    expect(cfg.AGENT_GRPC_PING_TIMEOUT_SEC).toBe(10);
    expect(cfg.AGENT_REGISTRATION_TIMEOUT_SEC).toBe(30);
    expect(cfg.AGENT_HEARTBEAT_ACK_TIMEOUT_SEC).toBe(30);
    expect(cfg.AGENT_REACHABILITY_PROBE_ENABLED).toBe(false);
    expect(cfg.LOG_LEVEL).toBe("info");
    expect(cfg.AGENT_FILE_TRANSFER_CONNECT_TO).toBe("localhost:9000:host.docker.internal:9000");
    expect(cfg.AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO).toBeUndefined();
    expect(cfg.AGENT_K8S_DEFAULT_IMAGE).toBe("busybox:latest");
  });

  test("coerces HEARTBEAT_INTERVAL_SEC from string", () => {
    const cfg = loadAgentConfig({ ...baseEnv, HEARTBEAT_INTERVAL_SEC: "60" });
    expect(cfg.HEARTBEAT_INTERVAL_SEC).toBe(60);
  });

  test("loads custom reconnect liveness settings", () => {
    const cfg = loadAgentConfig({
      ...baseEnv,
      AGENT_GRPC_PING_INTERVAL_SEC: "45",
      AGENT_GRPC_PING_TIMEOUT_SEC: "12",
      AGENT_REGISTRATION_TIMEOUT_SEC: "20",
      AGENT_HEARTBEAT_ACK_TIMEOUT_SEC: "40",
    });

    expect(cfg.AGENT_GRPC_PING_INTERVAL_SEC).toBe(45);
    expect(cfg.AGENT_GRPC_PING_TIMEOUT_SEC).toBe(12);
    expect(cfg.AGENT_REGISTRATION_TIMEOUT_SEC).toBe(20);
    expect(cfg.AGENT_HEARTBEAT_ACK_TIMEOUT_SEC).toBe(40);
  });

  test("bounds reconnect liveness settings to safe operational ranges", () => {
    expect(
      loadAgentConfig({
        ...baseEnv,
        AGENT_GRPC_PING_INTERVAL_SEC: "7200",
        AGENT_GRPC_PING_TIMEOUT_SEC: "300",
        AGENT_REGISTRATION_TIMEOUT_SEC: "600",
        AGENT_HEARTBEAT_ACK_TIMEOUT_SEC: "300",
      }),
    ).toMatchObject({
      AGENT_GRPC_PING_INTERVAL_SEC: 7200,
      AGENT_GRPC_PING_TIMEOUT_SEC: 300,
      AGENT_REGISTRATION_TIMEOUT_SEC: 600,
      AGENT_HEARTBEAT_ACK_TIMEOUT_SEC: 300,
    });
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_GRPC_PING_INTERVAL_SEC: "7201" })).toThrow();
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_GRPC_PING_TIMEOUT_SEC: "301" })).toThrow();
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_REGISTRATION_TIMEOUT_SEC: "601" })).toThrow();
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_HEARTBEAT_ACK_TIMEOUT_SEC: "301" })).toThrow();
  });

  test("allows the reachability probe only for explicit HTTPS mTLS deployments", () => {
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_REACHABILITY_PROBE_ENABLED: "true" })).toThrow(
      "requires HTTPS and Agent mTLS",
    );
    expect(
      loadAgentConfig({
        ...baseEnv,
        SERVER_GRPC_URL: "https://server.example:3001",
        AGENT_MTLS_REQUIRED: "true",
        AGENT_REACHABILITY_PROBE_ENABLED: "true",
      }).AGENT_REACHABILITY_PROBE_ENABLED,
    ).toBe(true);
  });

  test("respects custom file-transfer connect-to mapping", () => {
    const cfg = loadAgentConfig({
      ...baseEnv,
      AGENT_FILE_TRANSFER_CONNECT_TO: "localhost:19000:host.docker.internal:19000",
    });
    expect(cfg.AGENT_FILE_TRANSFER_CONNECT_TO).toBe("localhost:19000:host.docker.internal:19000");
  });

  test("supports a separate scheduler-container connect-to mapping", () => {
    const cfg = loadAgentConfig({
      ...baseEnv,
      AGENT_FILE_TRANSFER_CONNECT_TO: "",
      AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO: "localhost:19000:host.docker.internal:19000",
    });
    expect(cfg.AGENT_FILE_TRANSFER_CONNECT_TO).toBe("");
    expect(cfg.AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO).toBe(
      "localhost:19000:host.docker.internal:19000",
    );
  });

  test("requires Sandbox managed root to be a dedicated absolute path", () => {
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_SANDBOX_ROOT: "/" })).toThrow(
      "dedicated absolute path",
    );
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_SANDBOX_ROOT: "../sandbox" })).toThrow(
      "dedicated absolute path",
    );
    expect(loadAgentConfig({ ...baseEnv, AGENT_SANDBOX_ROOT: "/srv/kq/sandbox" })).toMatchObject({
      AGENT_SANDBOX_ROOT: "/srv/kq/sandbox",
    });
  });

  test("configures dedicated Data Market dataset and job roots", () => {
    const defaults = loadAgentConfig(baseEnv);
    expect(defaults.AGENT_DATASET_ROOT).toBe("/var/lib/kuintessence/datasets");
    expect(defaults.AGENT_DATASET_ROOTS_JSON).toEqual({});
    expect(defaults.AGENT_JOB_WORK_ROOT).toBe("/var/lib/kuintessence/jobs");
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_JOB_WORK_ROOT: "../jobs" })).toThrow(
      "dedicated absolute path",
    );
    const managedRootId = "11111111-1111-4111-8111-111111111111";
    expect(
      loadAgentConfig({
        ...baseEnv,
        AGENT_DATASET_ROOTS_JSON: JSON.stringify({ [managedRootId]: "provider-a" }),
      }).AGENT_DATASET_ROOTS_JSON,
    ).toEqual({ [managedRootId]: "provider-a" });
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_DATASET_ROOTS_JSON: JSON.stringify({ [managedRootId]: "../outside" }),
      }),
    ).toThrow("canonical and relative");
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_DATASET_ROOTS_JSON: JSON.stringify({ [managedRootId]: "provider/./datasets" }),
      }),
    ).toThrow("canonical and relative");
  });

  test("output collection failure injection is unset by default and explicit when requested", () => {
    expect(loadAgentConfig(baseEnv).AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR).toBeUndefined();
    const cfg = loadAgentConfig({
      ...baseEnv,
      AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR: "chunks",
    });
    expect(cfg.AGENT_TEST_FAIL_OUTPUT_COLLECTION_DESCRIPTOR).toBe("chunks");
  });

  test("rejects invalid URL", () => {
    expect(() => loadAgentConfig({ ...baseEnv, SERVER_GRPC_URL: "not-a-url" })).toThrow();
  });

  test("rejects missing AGENT_ID", () => {
    expect(() =>
      loadAgentConfig({ SERVER_GRPC_URL: "http://server:3001", AGENT_SITE_NAME: "x" }),
    ).toThrow();
  });

  test("defaults to host spawner backend with no container id", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_SPAWNER_BACKEND).toBe("host");
    expect(cfg.AGENT_SLURM_CONTAINER_ID).toBeUndefined();
  });

  test("rejects container backend without container id", () => {
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_SPAWNER_BACKEND: "container" })).toThrow(
      "AGENT_SLURM_CONTAINER_ID is required when AGENT_SPAWNER_BACKEND=container",
    );
  });

  test("accepts container backend with container id", () => {
    const cfg = loadAgentConfig({
      ...baseEnv,
      AGENT_SPAWNER_BACKEND: "container",
      AGENT_SLURM_CONTAINER_ID: "slurm-docker-ctr",
    });
    expect(cfg.AGENT_SPAWNER_BACKEND).toBe("container");
    expect(cfg.AGENT_SLURM_CONTAINER_ID).toBe("slurm-docker-ctr");
  });

  test("accepts a controlled Kubernetes worker image", () => {
    expect(
      loadAgentConfig({
        ...baseEnv,
        AGENT_K8S_DEFAULT_IMAGE: "kq-governed-spack:zlib-1.3.1",
      }).AGENT_K8S_DEFAULT_IMAGE,
    ).toBe("kq-governed-spack:zlib-1.3.1");
  });

  // mTLS additions
  test("AGENT_MTLS_REQUIRED defaults to false", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_MTLS_REQUIRED).toBe(false);
  });

  test("AGENT_MTLS_REQUIRED parses 'true' to boolean", () => {
    const cfg = loadAgentConfig({ ...baseEnv, AGENT_MTLS_REQUIRED: "true" });
    expect(cfg.AGENT_MTLS_REQUIRED).toBe(true);
  });

  test("AGENT_CERT_DIR defaults to ./agent-certs", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_CERT_DIR).toBe("./agent-certs");
  });

  test("AGENT_ENROLL_TOKEN is optional and undefined by default", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_ENROLL_TOKEN).toBeUndefined();
  });

  // Spack additions
  test("AGENT_SPACK_ENABLED defaults to false", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_SPACK_ENABLED).toBe(false);
  });

  test("AGENT_SPACK_ENABLED parses 'true' to boolean", () => {
    const cfg = loadAgentConfig({ ...baseEnv, AGENT_SPACK_ENABLED: "true" });
    expect(cfg.AGENT_SPACK_ENABLED).toBe(true);
  });

  test("AGENT_SPACK_PATH defaults to 'spack' (PATH lookup)", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_SPACK_PATH).toBe("spack");
  });

  test("AGENT_SPACK_PATH respects custom binary path", () => {
    const cfg = loadAgentConfig({ ...baseEnv, AGENT_SPACK_PATH: "/opt/spack/bin/spack" });
    expect(cfg.AGENT_SPACK_PATH).toBe("/opt/spack/bin/spack");
  });

  // SSH relay master switch
  test("AGENT_SSH_ENABLED defaults to true (relay needs no agent-side setup; Server RBAC-gates)", () => {
    const cfg = loadAgentConfig(baseEnv);
    expect(cfg.AGENT_SSH_ENABLED).toBe(true);
  });

  test("AGENT_SSH_ENABLED parses 'false' to disable the relay on locked-down nodes", () => {
    const cfg = loadAgentConfig({ ...baseEnv, AGENT_SSH_ENABLED: "false" });
    expect(cfg.AGENT_SSH_ENABLED).toBe(false);
  });

  test("AGENT_SSH_STRICT_ALGORITHMS defaults to false (compat) and parses 'true'", () => {
    expect(loadAgentConfig(baseEnv).AGENT_SSH_STRICT_ALGORITHMS).toBe(false);
    expect(
      loadAgentConfig({ ...baseEnv, AGENT_SSH_STRICT_ALGORITHMS: "true" })
        .AGENT_SSH_STRICT_ALGORITHMS,
    ).toBe(true);
  });

  test("Sandbox is fail-closed by default and parses pinned runtime/key catalogs", () => {
    const defaults = loadAgentConfig(baseEnv);
    expect(defaults.AGENT_SANDBOX_ENABLED).toBe(false);
    expect(defaults.AGENT_SANDBOX_EXECUTION_MODE).toBe("disabled");
    expect(defaults.AGENT_SANDBOX_ROOT_IMPERSONATION).toBe(false);
    expect(defaults.AGENT_SANDBOX_PUBLIC_KEYS_JSON).toEqual({});
    const digest = `sha256:${"1".repeat(64)}`;
    const config = loadAgentConfig({
      ...baseEnv,
      AGENT_SANDBOX_ENABLED: "true",
      AGENT_SANDBOX_PUBLIC_KEYS_JSON: JSON.stringify({ platform: "PUBLIC KEY" }),
      AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
        [digest]: { kind: "SIF", localPath: "/runtime/python.sif", signatureVerified: true },
      }),
    });
    expect(config.AGENT_SANDBOX_ENABLED).toBe(true);
    expect(config.AGENT_SANDBOX_RUNTIME_CACHE_JSON[digest]?.localPath).toBe("/runtime/python.sif");
  });

  test("accepts only digest-pinned OCI runtime refs matching the cache key", () => {
    const digest = `sha256:${"1".repeat(64)}`;
    const runtimeRef = `registry.example/kq/python@${digest}`;
    const config = loadAgentConfig({
      ...baseEnv,
      AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
        [digest]: { kind: "OCI", localPath: runtimeRef, signatureVerified: true },
      }),
    });
    expect(config.AGENT_SANDBOX_RUNTIME_CACHE_JSON[digest]?.localPath).toBe(runtimeRef);

    for (const localPath of [
      "registry.example/kq/python:latest",
      `/registry.example/kq/python@${digest}`,
      `registry.example/kq/../python@${digest}`,
      `registry.example/kq/python@${digest}\n`,
    ]) {
      expect(() =>
        loadAgentConfig({
          ...baseEnv,
          AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
            [digest]: { kind: "OCI", localPath, signatureVerified: true },
          }),
        }),
      ).toThrow();
    }

    const otherDigest = `sha256:${"2".repeat(64)}`;
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
          [digest]: {
            kind: "OCI",
            localPath: `registry.example/kq/python@${otherDigest}`,
            signatureVerified: true,
          },
        }),
      }),
    ).toThrow("OCI runtime digest must match its runtime cache key");
  });

  test("accepts supported OCI registry, tag, IPv6, and repository forms", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const refs = [
      `python@${digest}`,
      `python:release-1@${digest}`,
      `example.com@${digest}`,
      `localhost@${digest}`,
      `127.0.0.1@${digest}`,
      `localhost:5000/kq/python@${digest}`,
      `REGISTRY.EXAMPLE/kq/python:Release_1@${digest}`,
      `127.0.0.1:1/kq/python@${digest}`,
      `[2001:DB8::1]:65535/kq/python@${digest}`,
      `library/repo.name@${digest}`,
      `library/repo_name@${digest}`,
      `library/repo-name@${digest}`,
      `library/repo__name@${digest}`,
      `${"a".repeat(255)}@${digest}`,
    ];
    for (const localPath of refs) {
      const config = loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
          [digest]: { kind: "OCI", localPath, signatureVerified: true },
        }),
      });
      expect(config.AGENT_SANDBOX_RUNTIME_CACHE_JSON[digest]?.localPath).toBe(localPath);
    }
  });

  test("rejects invalid OCI ports, repository separators, and path forms", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const invalidRefs = [
      `localhost:0/kq/python@${digest}`,
      `localhost:65536/kq/python@${digest}`,
      `localhost:99999/kq/python@${digest}`,
      `registry.example/repo..name@${digest}`,
      `registry.example/repo___name@${digest}`,
      `registry.example/repo-_name@${digest}`,
      `registry.example/repo._name@${digest}`,
      `registry.example/repo/../name@${digest}`,
      `registry.example//repo@${digest}`,
      `registry.example/Repo@${digest}`,
      `registry.example/repo.@${digest}`,
      `registry.example/repo:@${digest}`,
      `[2001:db8::1]5000/kq/python@${digest}`,
      `[fe80::1%eth0]:5000/kq/python@${digest}`,
      `[::ffff:192.0.2.1]:5000/kq/python@${digest}`,
      `registry.example/${"a".repeat(256)}@${digest}`,
    ];
    for (const localPath of invalidRefs) {
      expect(() =>
        loadAgentConfig({
          ...baseEnv,
          AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
            [digest]: { kind: "OCI", localPath, signatureVerified: true },
          }),
        }),
      ).toThrow();
    }
  });

  test("rejects long malformed OCI refs without regex backtracking", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const env = {
      ...baseEnv,
      AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
        [digest]: {
          kind: "OCI",
          localPath: `${"registry.example/".repeat(32)}!@${digest}`,
          signatureVerified: true,
        },
      }),
    };
    for (let index = 0; index < 24; index += 1) {
      expect(() => loadAgentConfig(env)).toThrow();
    }
  });

  test("keeps SIF runtime paths absolute and traversal-free", () => {
    const digest = `sha256:${"d".repeat(64)}`;
    for (const localPath of ["runtime/python.sif", "/", "/runtime/../python.sif"]) {
      expect(() =>
        loadAgentConfig({
          ...baseEnv,
          AGENT_SANDBOX_RUNTIME_CACHE_JSON: JSON.stringify({
            [digest]: { kind: "SIF", localPath, signatureVerified: true },
          }),
        }),
      ).toThrow();
    }
  });

  test("rejects malformed Sandbox JSON configuration", () => {
    expect(() =>
      loadAgentConfig({ ...baseEnv, AGENT_SANDBOX_RUNTIME_CACHE_JSON: "not-json" }),
    ).toThrow();
  });

  test("rejects an ambiguous self-account or incomplete seccomp configuration", () => {
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_EXECUTION_MODE: "self-account",
        AGENT_SANDBOX_ROOT_IMPERSONATION: "true",
      }),
    ).toThrow("cannot enable root impersonation");
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_SECCOMP_PROFILE_PATH: "/etc/kuintessence/seccomp.json",
      }),
    ).toThrow("configured together");
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_K8S_SECCOMP_PROFILE: "kuintessence/kq-no-network.json",
      }),
    ).toThrow("configured together");
    expect(() =>
      loadAgentConfig({
        ...baseEnv,
        AGENT_SANDBOX_K8S_SECCOMP_PROFILE: "../kq-no-network.json",
        AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256: "a".repeat(64),
        AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME: "k3s-1",
      }),
    ).toThrow("canonical relative path");
  });

  test("restricted data isolation requires a pinned trusted execution SIF, not a mount driver", () => {
    expect(loadAgentConfig(baseEnv).AGENT_DATA_READONLY_MOUNT_DRIVER).toBe("disabled");
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_RESTRICTED_DATA_ISOLATION: "true" })).toThrow(
      "AGENT_RESTRICTED_EXECUTION_SIF_DIGEST",
    );
    const digest = `sha256:${"1".repeat(64)}`;
    const profileId = "00000000-0000-4000-8000-000000000444";
    const wrapperSha256 = "a".repeat(64);
    const config = loadAgentConfig({
      ...baseEnv,
      AGENT_RESTRICTED_DATA_ISOLATION: "true",
      AGENT_RESTRICTED_EXECUTION_SIF_DIGEST: digest,
      AGENT_RESTRICTED_EXECUTION_PROFILE_ID: profileId,
      AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256: wrapperSha256,
    });
    expect(config.AGENT_RESTRICTED_EXECUTION_SIF_DIGEST).toBe(digest);
    expect(config.AGENT_RESTRICTED_EXECUTION_PROFILE_ID).toBe(profileId);
    expect(config.AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256).toBe(wrapperSha256);
  });
});
