import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type ComposeOptions,
  type ComposeProfile,
  composeEnvForCasdoor,
  composeEnvForSpiceDB,
  getSpiceDBEndpoint,
  normalizeSpiceDBEndpoint,
} from "./compose";

const SCHEDULER_PROFILE: ComposeProfile = {
  key: "scheduler",
  label: "Scheduler smoke",
  description: "Server/Web/Registry plus Slurm, PBS, and K3s Agent smoke stack.",
  files: ["deploy/compose/docker-compose.schedulers.yml"],
  envFile: "deploy/schedulers/ports-alt.env",
  project: "kq-schedulers",
  urls: [],
  heavy: true,
  schedulerSmoke: true,
};

const WATCH_PROFILE: ComposeProfile = {
  key: "watch",
  label: "Full stack watch",
  description: "Run Server, Registry, and Web as in-container dev/watch servers.",
  files: ["deploy/compose/docker-compose.yml", "deploy/compose/docker-compose.watch.yml"],
  urls: [],
  heavy: false,
  schedulerSmoke: false,
};

const TEST_OPTIONS: ComposeOptions = {
  build: false,
  attach: false,
  follow: false,
  volumes: false,
  recreate: false,
  dryRun: false,
  noVerify: false,
  spicedbExternal: true,
  casdoorExternal: false,
  services: [],
  help: false,
};

describe("normalizeSpiceDBEndpoint", () => {
  test("strips http scheme and keeps host:port", () => {
    expect(normalizeSpiceDBEndpoint("http://host.docker.internal:50051")).toBe(
      "host.docker.internal:50051",
    );
  });

  test("strips https scheme", () => {
    expect(normalizeSpiceDBEndpoint("https://127.0.0.1:50051")).toBe("127.0.0.1:50051");
  });

  test("returns trimmed raw host when not parseable as URL", () => {
    expect(normalizeSpiceDBEndpoint("  host.docker.internal:50051   ")).toBe(
      "host.docker.internal:50051",
    );
  });

  test("returns raw value when invalid URL format cannot be parsed", () => {
    expect(normalizeSpiceDBEndpoint("notaurl://:bad")).toBe("notaurl://:bad");
  });
});

describe("composeEnvForSpiceDB", () => {
  const envBackup = {
    generic: Bun.env.KQ_SPICEDB_ENDPOINT,
    scheduler: Bun.env.KQ_SCHEDULER_SPICEDB_ENDPOINT,
  };

  afterEach(() => {
    if (envBackup.generic === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SPICEDB_ENDPOINT;
    } else {
      process.env.KQ_SPICEDB_ENDPOINT = envBackup.generic;
    }

    if (envBackup.scheduler === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_SPICEDB_ENDPOINT;
    } else {
      process.env.KQ_SCHEDULER_SPICEDB_ENDPOINT = envBackup.scheduler;
    }
  });

  beforeEach(() => {
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SPICEDB_ENDPOINT;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_SPICEDB_ENDPOINT;
  });

  test("injects normalized scheduler endpoint for scheduler profiles", () => {
    process.env.KQ_SCHEDULER_SPICEDB_ENDPOINT = "http://host.docker.internal:50051";
    expect(composeEnvForSpiceDB(SCHEDULER_PROFILE, TEST_OPTIONS)).toEqual([
      "KQ_SCHEDULER_SPICEDB_ENDPOINT=host.docker.internal:50051",
    ]);
  });

  test("prioritizes scheduler scoped endpoint when both envs are set", () => {
    process.env.KQ_SPICEDB_ENDPOINT = "http://127.0.0.1:50051";
    process.env.KQ_SCHEDULER_SPICEDB_ENDPOINT = "http://192.168.1.100:50051";
    expect(composeEnvForSpiceDB(SCHEDULER_PROFILE, TEST_OPTIONS)).toEqual([
      "KQ_SCHEDULER_SPICEDB_ENDPOINT=192.168.1.100:50051",
    ]);
  });

  test("uses scheduler env key even when only generic endpoint is provided", () => {
    process.env.KQ_SPICEDB_ENDPOINT = "http://127.0.0.1:50051";
    expect(composeEnvForSpiceDB(SCHEDULER_PROFILE, TEST_OPTIONS)).toEqual([
      "KQ_SCHEDULER_SPICEDB_ENDPOINT=127.0.0.1:50051",
    ]);
  });

  test("injects generic endpoint when scheduler override is absent", () => {
    process.env.KQ_SPICEDB_ENDPOINT = "http://127.0.0.1:50051";
    expect(composeEnvForSpiceDB(WATCH_PROFILE, TEST_OPTIONS)).toEqual([
      "KQ_SPICEDB_ENDPOINT=127.0.0.1:50051",
    ]);
  });

  test("does not inject for non-server profiles", () => {
    const infraProfile: ComposeProfile = {
      key: "infra",
      label: "Infra only",
      description: "Postgres + Redis + MinIO only; use when app services run on host.",
      files: ["deploy/compose/docker-compose.dev.yml"],
      urls: [],
    };
    process.env.KQ_SPICEDB_ENDPOINT = "http://127.0.0.1:50051";
    expect(composeEnvForSpiceDB(infraProfile, TEST_OPTIONS)).toEqual([]);
  });

  test("throws when scheduler external flag is set without endpoint", () => {
    expect(() => composeEnvForSpiceDB(SCHEDULER_PROFILE, TEST_OPTIONS)).toThrow(
      "Using --spicedb-external requires KQ_SPICEDB_ENDPOINT (or KQ_SCHEDULER_SPICEDB_ENDPOINT) to be set to the external gRPC endpoint",
    );
  });

  test("reads normalized endpoint via getSpiceDBEndpoint", () => {
    process.env.KQ_SPICEDB_ENDPOINT = "https://127.0.0.1:50051";
    expect(getSpiceDBEndpoint(WATCH_PROFILE)).toBe("127.0.0.1:50051");
  });
});

describe("composeEnvForCasdoor", () => {
  const envBackup = {
    schedulerIssuer: Bun.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL,
    schedulerClientId: Bun.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID,
    schedulerClientSecret: Bun.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET,
    schedulerRedirectUri: Bun.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI,
    schedulerGroupMapping: Bun.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING,
    genericIssuer: Bun.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL,
    genericClientId: Bun.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID,
    genericClientSecret: Bun.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET,
    genericRedirectUri: Bun.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI,
    genericGroupMapping: Bun.env.KQ_CASDOOR_BOOTSTRAP_GROUP_MAPPING,
  };

  afterEach(() => {
    if (envBackup.schedulerIssuer === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL;
    } else {
      process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL = envBackup.schedulerIssuer;
    }
    if (envBackup.schedulerClientId === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID;
    } else {
      process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID = envBackup.schedulerClientId;
    }
    if (envBackup.schedulerClientSecret === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET;
    } else {
      process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET = envBackup.schedulerClientSecret;
    }
    if (envBackup.schedulerRedirectUri === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI;
    } else {
      process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI = envBackup.schedulerRedirectUri;
    }
    if (envBackup.schedulerGroupMapping === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING;
    } else {
      process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING = envBackup.schedulerGroupMapping;
    }

    if (envBackup.genericIssuer === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL;
    } else {
      process.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL = envBackup.genericIssuer;
    }
    if (envBackup.genericClientId === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID;
    } else {
      process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID = envBackup.genericClientId;
    }
    if (envBackup.genericClientSecret === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET;
    } else {
      process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET = envBackup.genericClientSecret;
    }
    if (envBackup.genericRedirectUri === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI;
    } else {
      process.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI = envBackup.genericRedirectUri;
    }
    if (envBackup.genericGroupMapping === undefined) {
      // eslint-disable-next-line no-undefined
      delete process.env.KQ_CASDOOR_BOOTSTRAP_GROUP_MAPPING;
    } else {
      process.env.KQ_CASDOOR_BOOTSTRAP_GROUP_MAPPING = envBackup.genericGroupMapping;
    }
  });

  beforeEach(() => {
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI;
    // eslint-disable-next-line no-undefined
    delete process.env.KQ_CASDOOR_BOOTSTRAP_GROUP_MAPPING;
  });

  const casdoorTestOptions: ComposeOptions = {
    ...TEST_OPTIONS,
    spicedbExternal: false,
    casdoorExternal: true,
  };

  test("injects generic casdoor bootstrap envs for non-scheduler profiles", () => {
    process.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL = "https://idp.example.com/sso";
    process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID = "generic-client-id";
    process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET = "generic-client-secret";
    process.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI = "https://app.example.com/auth/callback";

    expect(composeEnvForCasdoor(WATCH_PROFILE, casdoorTestOptions)).toEqual([
      "KQ_CASDOOR_BOOTSTRAP_ISSUER_URL=https://idp.example.com/sso",
      "KQ_CASDOOR_BOOTSTRAP_CLIENT_ID=generic-client-id",
      "KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET=generic-client-secret",
      "KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI=https://app.example.com/auth/callback",
    ]);
  });

  test("injects scheduler casdoor bootstrap envs when scheduler vars are provided", () => {
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL = "https://idp-sched.example.com/sso";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID = "sched-client-id";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET = "sched-client-secret";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI =
      "https://app.example.com/scheduler/callback";

    expect(composeEnvForCasdoor(SCHEDULER_PROFILE, casdoorTestOptions)).toEqual([
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL=https://idp-sched.example.com/sso",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID=sched-client-id",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET=sched-client-secret",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI=https://app.example.com/scheduler/callback",
    ]);
  });

  test("scheduler profile falls back to generic bootstrap envs when scheduler-specific are absent", () => {
    process.env.KQ_CASDOOR_BOOTSTRAP_ISSUER_URL = "https://idp.example.com/sso";
    process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_ID = "generic-client-id";
    process.env.KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET = "generic-client-secret";
    process.env.KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI = "https://app.example.com/auth/callback";

    expect(composeEnvForCasdoor(SCHEDULER_PROFILE, casdoorTestOptions)).toEqual([
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL=https://idp.example.com/sso",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID=generic-client-id",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET=generic-client-secret",
      "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI=https://app.example.com/auth/callback",
    ]);
  });

  test("includes optional scheduler group mapping when provided", () => {
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL = "https://idp-sched.example.com/sso";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID = "sched-client-id";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET = "sched-client-secret";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI =
      "https://app.example.com/scheduler/callback";
    process.env.KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING = '{"group_admin":"platform_admin"}';

    expect(composeEnvForCasdoor(SCHEDULER_PROFILE, casdoorTestOptions)).toContainEqual(
      'KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING={"group_admin":"platform_admin"}',
    );
  });

  test("throws when required casdoor bootstrap params are missing", () => {
    expect(() => composeEnvForCasdoor(WATCH_PROFILE, casdoorTestOptions)).toThrow(
      "Using --casdoor-external requires one of KQ_CASDOOR_BOOTSTRAP_ISSUER_URL/KQ_CASDOOR_BOOTSTRAP_CLIENT_ID/KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET/KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI",
    );
  });
});
