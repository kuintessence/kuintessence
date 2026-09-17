import { createInterface } from "node:readline/promises";

type Action = "up" | "down" | "restart" | "ps" | "logs" | "config" | "build" | "pull" | "verify";

type ProfileKey =
  | "infra"
  | "full"
  | "watch"
  | "netdrive"
  | "watch-netdrive"
  | "scheduler"
  | "scheduler-watch"
  | "aio"
  | "demo";

interface Profile {
  key: ProfileKey;
  label: string;
  description: string;
  files: string[];
  envFile?: string;
  project?: string;
  urls: string[];
  heavy?: boolean;
  schedulerSmoke?: boolean;
}

// Exported for test coverage.
export interface ComposeProfile extends Profile {}

interface Options {
  profile?: ProfileKey;
  action?: Action;
  build: boolean;
  attach: boolean;
  follow: boolean;
  volumes: boolean;
  recreate: boolean;
  dryRun: boolean;
  noVerify: boolean;
  spicedbExternal: boolean;
  casdoorExternal: boolean;
  services: string[];
  help: boolean;
}

// Exported for test coverage.
export interface ComposeOptions extends Options {}

interface CasdoorProfile extends Pick<Profile, "key"> {}

const PROFILES: Record<ProfileKey, Profile> = {
  infra: {
    key: "infra",
    label: "Infra only",
    description: "Postgres + Redis + MinIO only; use when app services run on host.",
    files: ["deploy/compose/docker-compose.dev.yml"],
    urls: [
      "Postgres: localhost:5432",
      "Redis: localhost:6379",
      "MinIO API: http://localhost:9000",
      "MinIO console: http://localhost:9001",
    ],
  },
  full: {
    key: "full",
    label: "Full stack",
    description: "Build Server, Registry, and static Web image from local sources.",
    files: ["deploy/compose/docker-compose.yml"],
    urls: [
      "Web: http://localhost:5173",
      "Server HTTP: http://localhost:3000",
      "Server gRPC: localhost:3001",
      "Registry: http://localhost:3100",
      "MinIO console: http://localhost:9001",
    ],
  },
  watch: {
    key: "watch",
    label: "Full stack watch",
    description: "Run Server, Registry, and Web as in-container dev/watch servers.",
    files: ["deploy/compose/docker-compose.yml", "deploy/compose/docker-compose.watch.yml"],
    urls: [
      "Web: http://localhost:5173",
      "Server HTTP: http://localhost:3000",
      "Server gRPC: localhost:3001",
      "Registry: http://localhost:3100",
      "MinIO console: http://localhost:9001",
    ],
  },
  netdrive: {
    key: "netdrive",
    label: "Full stack + NetDrive override",
    description: "Full stack with deploy/compose/docker-compose.local.yml NetDrive settings.",
    files: ["deploy/compose/docker-compose.yml", "deploy/compose/docker-compose.local.yml"],
    urls: [
      "Web: http://localhost:5173",
      "Server HTTP: http://localhost:3010",
      "Server gRPC: localhost:3011",
      "Registry: http://localhost:3100",
      "MinIO console: http://localhost:9001",
    ],
  },
  "watch-netdrive": {
    key: "watch-netdrive",
    label: "Watch + NetDrive override",
    description: "In-container watch servers plus NetDrive local settings.",
    files: [
      "deploy/compose/docker-compose.yml",
      "deploy/compose/docker-compose.watch.yml",
      "deploy/compose/docker-compose.local.yml",
    ],
    urls: [
      "Web: http://localhost:5173",
      "Server HTTP: http://localhost:3010",
      "Server gRPC: localhost:3011",
      "Registry: http://localhost:3100",
      "MinIO console: http://localhost:9001",
    ],
  },
  scheduler: {
    key: "scheduler",
    label: "Scheduler local stack",
    description: "Single-file local stack with Server, Registry, Web, Slurm, PBS, and K3s Agents.",
    files: ["deploy/compose/docker-compose.schedulers.yml"],
    envFile: "deploy/schedulers/ports-alt.env",
    project: "kq-schedulers",
    urls: [
      "Web: http://localhost:15173",
      "Server HTTP: http://localhost:13000",
      "Server gRPC: localhost:13001",
      "Registry: http://localhost:13100",
      "MinIO console: http://localhost:19001",
    ],
    heavy: true,
    schedulerSmoke: true,
  },
  "scheduler-watch": {
    key: "scheduler-watch",
    label: "Scheduler local stack",
    description:
      "Alias of scheduler; kept for old commands while using the same single compose file.",
    files: ["deploy/compose/docker-compose.schedulers.yml"],
    envFile: "deploy/schedulers/ports-alt.env",
    project: "kq-schedulers",
    urls: [
      "Web: http://localhost:15173",
      "Server HTTP: http://localhost:13000",
      "Server gRPC: localhost:13001",
      "Registry: http://localhost:13100",
      "MinIO console: http://localhost:19001",
    ],
    heavy: true,
    schedulerSmoke: true,
  },
  aio: {
    key: "aio",
    label: "All-in-one demo",
    description: "Single all-in-one demo container with bundled services.",
    files: ["deploy/compose/docker-compose.aio.yml"],
    urls: ["Web + Server API: http://localhost:8080", "MinIO console: http://localhost:9001"],
    heavy: true,
  },
  demo: {
    key: "demo",
    label: "Example demo",
    description: "Example deployment compose under examples/.",
    files: ["examples/docker-compose.demo.yml"],
    project: "kq-demo",
    urls: [
      "Server HTTP: http://localhost:3000",
      "Server gRPC: localhost:3001",
      "Registry: http://localhost:3100",
      "MinIO console: http://localhost:9001",
    ],
  },
};

const PROFILE_ALIASES: Record<string, ProfileKey> = {
  dev: "watch",
  local: "netdrive",
  schedulers: "scheduler",
  "scheduler-dev": "scheduler-watch",
};

const ACTIONS: Action[] = [
  "up",
  "down",
  "restart",
  "ps",
  "logs",
  "config",
  "build",
  "pull",
  "verify",
];

const SPICEDB_EXTERNAL_COMPOSE = "deploy/compose/docker-compose.spicedb-external.yml";
const SPICEDB_EXTERNAL_ENDPOINT_ENV_KEY = "KQ_SPICEDB_ENDPOINT";
const SPICEDB_EXTERNAL_ENDPOINT_SCHEDULER_KEY = "KQ_SCHEDULER_SPICEDB_ENDPOINT";
const CASDOOR_EXTERNAL_COMPOSE = "deploy/compose/docker-compose.casdoor-external.yml";
const CASDOOR_BOOTSTRAP_ISSUER_ENV_KEY = "KQ_CASDOOR_BOOTSTRAP_ISSUER_URL";
const CASDOOR_BOOTSTRAP_CLIENT_ID_ENV_KEY = "KQ_CASDOOR_BOOTSTRAP_CLIENT_ID";
const CASDOOR_BOOTSTRAP_CLIENT_SECRET_ENV_KEY = "KQ_CASDOOR_BOOTSTRAP_CLIENT_SECRET";
const CASDOOR_BOOTSTRAP_REDIRECT_URI_ENV_KEY = "KQ_CASDOOR_BOOTSTRAP_REDIRECT_URI";
const CASDOOR_BOOTSTRAP_GROUP_MAPPING_ENV_KEY = "KQ_CASDOOR_BOOTSTRAP_GROUP_MAPPING";
const CASDOOR_SCHEDULER_BOOTSTRAP_ISSUER_ENV_KEY = "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_ISSUER_URL";
const CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_ID_ENV_KEY = "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_ID";
const CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_SECRET_ENV_KEY =
  "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_CLIENT_SECRET";
const CASDOOR_SCHEDULER_BOOTSTRAP_REDIRECT_URI_ENV_KEY =
  "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_REDIRECT_URI";
const CASDOOR_SCHEDULER_BOOTSTRAP_GROUP_MAPPING_ENV_KEY =
  "KQ_SCHEDULER_CASDOOR_BOOTSTRAP_GROUP_MAPPING";

export function normalizeSpiceDBEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed.includes("://")) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.host;
  } catch {
    return trimmed;
  }
}

function isSchedulerKey(value: Pick<CasdoorProfile, "key">): boolean {
  return value.key.startsWith("scheduler");
}

export function getSpiceDBEndpoint(profile?: Pick<CasdoorProfile, "key">): string | undefined {
  const schedulerScoped = profile !== undefined && isSchedulerKey(profile);
  const endpoint = schedulerScoped
    ? (Bun.env[SPICEDB_EXTERNAL_ENDPOINT_SCHEDULER_KEY] ??
      Bun.env[SPICEDB_EXTERNAL_ENDPOINT_ENV_KEY])
    : (Bun.env[SPICEDB_EXTERNAL_ENDPOINT_ENV_KEY] ??
      Bun.env[SPICEDB_EXTERNAL_ENDPOINT_SCHEDULER_KEY]);
  if (endpoint === undefined) return undefined;
  return normalizeSpiceDBEndpoint(endpoint);
}

export function composeEnvForSpiceDB(
  profile: Pick<ComposeProfile, "files" | "key">,
  options: Pick<ComposeOptions, "spicedbExternal">,
): string[] {
  if (!options.spicedbExternal) return [];
  if (!composeProfileUsesServer(profile)) return [];
  const endpoint = getSpiceDBEndpoint(profile);
  if (!endpoint) {
    throw new Error(
      "Using --spicedb-external requires KQ_SPICEDB_ENDPOINT (or KQ_SCHEDULER_SPICEDB_ENDPOINT) to be set to the external gRPC endpoint",
    );
  }
  const key = isSchedulerProfile(profile)
    ? SPICEDB_EXTERNAL_ENDPOINT_SCHEDULER_KEY
    : SPICEDB_EXTERNAL_ENDPOINT_ENV_KEY;
  return [`${key}=${endpoint}`];
}

function composeProfileUsesServer(profile: Pick<Profile, "files">): boolean {
  return (
    profile.files.includes("deploy/compose/docker-compose.yml") ||
    profile.files.includes("deploy/compose/docker-compose.schedulers.yml")
  );
}

function isSchedulerProfile(profile: Pick<Profile, "key">): boolean {
  return profile.key.startsWith("scheduler");
}

function getCasdoorEnvValue(
  profile: Pick<Profile, "key">,
  schedulerKey: string,
  defaultKey: string,
): string | undefined {
  return isSchedulerProfile(profile)
    ? (Bun.env[schedulerKey] ?? Bun.env[defaultKey])
    : Bun.env[defaultKey];
}

function getCasdoorEnvPair(
  profile: Pick<Profile, "key">,
  schedulerKey: string,
  defaultKey: string,
): [string, string] | undefined {
  const value = getCasdoorEnvValue(profile, schedulerKey, defaultKey);
  if (value === undefined) return undefined;
  const injectedKey = isSchedulerProfile(profile) ? schedulerKey : defaultKey;
  return [injectedKey, value];
}

export function composeEnvForCasdoor(
  profile: Pick<Profile, "key" | "files">,
  opts: Pick<Options, "casdoorExternal">,
): string[] {
  if (!opts.casdoorExternal) return [];
  if (!composeProfileUsesServer(profile)) return [];
  const issuerPair = getCasdoorEnvPair(
    profile,
    CASDOOR_SCHEDULER_BOOTSTRAP_ISSUER_ENV_KEY,
    CASDOOR_BOOTSTRAP_ISSUER_ENV_KEY,
  );
  const clientIdPair = getCasdoorEnvPair(
    profile,
    CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_ID_ENV_KEY,
    CASDOOR_BOOTSTRAP_CLIENT_ID_ENV_KEY,
  );
  const clientSecretPair = getCasdoorEnvPair(
    profile,
    CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_SECRET_ENV_KEY,
    CASDOOR_BOOTSTRAP_CLIENT_SECRET_ENV_KEY,
  );
  const redirectUriPair = getCasdoorEnvPair(
    profile,
    CASDOOR_SCHEDULER_BOOTSTRAP_REDIRECT_URI_ENV_KEY,
    CASDOOR_BOOTSTRAP_REDIRECT_URI_ENV_KEY,
  );
  const groupMappingPair = getCasdoorEnvPair(
    profile,
    CASDOOR_SCHEDULER_BOOTSTRAP_GROUP_MAPPING_ENV_KEY,
    CASDOOR_BOOTSTRAP_GROUP_MAPPING_ENV_KEY,
  );

  if (!issuerPair || !clientIdPair || !clientSecretPair || !redirectUriPair) {
    const missingKey = isSchedulerProfile(profile)
      ? `one of ${CASDOOR_SCHEDULER_BOOTSTRAP_ISSUER_ENV_KEY}/${
          CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_ID_ENV_KEY
        }/${CASDOOR_SCHEDULER_BOOTSTRAP_CLIENT_SECRET_ENV_KEY}/${CASDOOR_SCHEDULER_BOOTSTRAP_REDIRECT_URI_ENV_KEY}`
      : `one of ${CASDOOR_BOOTSTRAP_ISSUER_ENV_KEY}/${CASDOOR_BOOTSTRAP_CLIENT_ID_ENV_KEY}/${
          CASDOOR_BOOTSTRAP_CLIENT_SECRET_ENV_KEY
        }/${CASDOOR_BOOTSTRAP_REDIRECT_URI_ENV_KEY}`;
    throw new Error(
      `Using --casdoor-external requires ${missingKey} to be set to the external Casdoor OIDC parameters`,
    );
  }

  const env = [
    `${issuerPair[0]}=${issuerPair[1]}`,
    `${clientIdPair[0]}=${clientIdPair[1]}`,
    `${clientSecretPair[0]}=${clientSecretPair[1]}`,
    `${redirectUriPair[0]}=${redirectUriPair[1]}`,
  ];

  if (groupMappingPair) {
    env.push(`${groupMappingPair[0]}=${groupMappingPair[1]}`);
  }

  return env;
}

function withEnvPrefix(
  profile: Profile,
  opts: Pick<Options, "spicedbExternal" | "casdoorExternal">,
  cmd: string[],
): string[] {
  const envPrefix = [
    ...composeEnvForSpiceDB(profile, opts),
    ...composeEnvForCasdoor(profile, opts),
  ];
  if (envPrefix.length === 0) return cmd;
  return ["env", ...envPrefix, ...cmd];
}

function usage(): string {
  return `Usage:
  bun run compose
  bun run compose -- <profile> [action] [options]
  bun run compose -- --profile <profile> --action <action> [options]

Profiles:
${Object.values(PROFILES)
  .map((p) => `  ${p.key.padEnd(15)} ${p.label} - ${p.description}`)
  .join("\n")}

Actions:
  up, down, restart, ps, logs, config, build, pull, verify

Options:
  -p, --profile <name>     Select profile
  -a, --action <name>      Select action
  -b, --build              Add --build for up, or build before scheduler smoke
      --attach             Run up attached instead of detached
      --follow             Follow logs
  -v, --volumes            Add -v for down/restart
      --recreate           Add --force-recreate for up
  -s, --service <name>     Limit compose action to service; repeatable
      --no-verify          For scheduler up, use raw compose up instead of smoke verification
      --spicedb-external   Append deploy/compose/docker-compose.spicedb-external.yml for non-scheduler Server profiles
      --casdoor-external    Append deploy/compose/docker-compose.casdoor-external.yml for non-scheduler Server profiles
      --dry-run            Print command only
  -h, --help               Show this help

Examples:
  bun run compose -- watch up --build
  bun run compose -- scheduler up
  bun run compose -- scheduler verify
  bun run compose -- scheduler-watch up --build
  bun run compose -- infra down -v
  bun run compose -- watch logs --follow --service web
`;
}

function parseProfile(value: string): ProfileKey | undefined {
  const normalized = value.trim();
  if (normalized in PROFILES) return normalized as ProfileKey;
  return PROFILE_ALIASES[normalized];
}

function parseAction(value: string): Action | undefined {
  return ACTIONS.includes(value as Action) ? (value as Action) : undefined;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    build: false,
    attach: false,
    follow: false,
    volumes: false,
    recreate: false,
    dryRun: false,
    noVerify: false,
    spicedbExternal: false,
    casdoorExternal: false,
    services: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "-p" || arg === "--profile") {
      const profile = parseProfile(takeValue(argv, i, arg));
      if (!profile) throw new Error(`Unknown profile: ${argv[i + 1]}`);
      opts.profile = profile;
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      const profile = parseProfile(arg.slice("--profile=".length));
      if (!profile) throw new Error(`Unknown profile: ${arg.slice("--profile=".length)}`);
      opts.profile = profile;
      continue;
    }
    if (arg === "-a" || arg === "--action") {
      const action = parseAction(takeValue(argv, i, arg));
      if (!action) throw new Error(`Unknown action: ${argv[i + 1]}`);
      opts.action = action;
      i += 1;
      continue;
    }
    if (arg.startsWith("--action=")) {
      const action = parseAction(arg.slice("--action=".length));
      if (!action) throw new Error(`Unknown action: ${arg.slice("--action=".length)}`);
      opts.action = action;
      continue;
    }
    if (arg === "-b" || arg === "--build") opts.build = true;
    else if (arg === "--attach") opts.attach = true;
    else if (arg === "--follow") opts.follow = true;
    else if (arg === "-v" || arg === "--volumes") opts.volumes = true;
    else if (arg === "--recreate") opts.recreate = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-verify") opts.noVerify = true;
    else if (arg === "--spicedb-external") opts.spicedbExternal = true;
    else if (arg === "--casdoor-external") opts.casdoorExternal = true;
    else if (arg === "-s" || arg === "--service") {
      opts.services.push(takeValue(argv, i, arg));
      i += 1;
    } else if (!arg.startsWith("-") && !opts.profile) {
      const profile = parseProfile(arg);
      if (!profile) throw new Error(`Unknown profile: ${arg}`);
      opts.profile = profile;
    } else if (!arg.startsWith("-") && !opts.action) {
      const action = parseAction(arg);
      if (!action) throw new Error(`Unknown action: ${arg}`);
      opts.action = action;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

async function choose<T extends string>(
  rl: ReturnType<typeof createInterface>,
  label: string,
  values: readonly T[],
  describe: (value: T) => string,
  fallback: T,
): Promise<T> {
  console.log(`\n${label}:`);
  values.forEach((value, index) => {
    console.log(`  ${index + 1}. ${describe(value)}`);
  });
  const answer = (await rl.question(`Choose [${values.indexOf(fallback) + 1}]: `)).trim();
  if (answer.length === 0) return fallback;
  const numeric = Number.parseInt(answer, 10);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= values.length) {
    const selected = values[numeric - 1];
    if (selected !== undefined) return selected;
  }
  const selected = values.find((value) => value === answer);
  if (selected !== undefined) return selected;
  throw new Error(`Invalid ${label.toLowerCase()}: ${answer}`);
}

async function yesNo(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  fallback: boolean,
): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${prompt} [${suffix}]: `)).trim().toLowerCase();
  if (answer.length === 0) return fallback;
  return answer === "y" || answer === "yes";
}

async function completeInteractive(opts: Options): Promise<Options> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const profiles = Object.keys(PROFILES) as ProfileKey[];
    const profile =
      opts.profile ?? (await choose(rl, "Profiles", profiles, describeProfile, "watch"));
    const action = opts.action ?? (await choose(rl, "Actions", ACTIONS, (a) => a, "up"));
    const next = { ...opts, profile, action };
    if (action === "up" || action === "restart") {
      next.build = opts.build || (await yesNo(rl, "Build images before start", profile === "aio"));
      next.attach = opts.attach || (await yesNo(rl, "Attach logs instead of detached mode", false));
      if (PROFILES[profile].schedulerSmoke) {
        next.noVerify =
          opts.noVerify || !(await yesNo(rl, "Run scheduler smoke verification", true));
      }
    }
    if (action === "down" || action === "restart") {
      next.volumes = opts.volumes || (await yesNo(rl, "Remove volumes", false));
    }
    if (action === "logs") {
      next.follow = opts.follow || (await yesNo(rl, "Follow logs", true));
    }
    return next;
  } finally {
    rl.close();
  }
}

function describeProfile(key: ProfileKey): string {
  const profile = PROFILES[key];
  return `${profile.key} - ${profile.label}: ${profile.description}`;
}

function composeFiles(
  profile: Profile,
  options: Pick<Options, "spicedbExternal" | "casdoorExternal">,
): string[] {
  const files = [...profile.files];
  if (
    options.spicedbExternal &&
    composeProfileUsesServer(profile) &&
    !isSchedulerProfile(profile)
  ) {
    files.push(SPICEDB_EXTERNAL_COMPOSE);
  }
  if (
    options.casdoorExternal &&
    composeProfileUsesServer(profile) &&
    !isSchedulerProfile(profile)
  ) {
    files.push(CASDOOR_EXTERNAL_COMPOSE);
  }
  return files;
}

function validateProfileOptions(
  profile: Profile,
  options: Pick<Options, "spicedbExternal" | "casdoorExternal">,
): void {
  if (!isSchedulerProfile(profile)) return;
  if (!options.spicedbExternal && !options.casdoorExternal) return;
  throw new Error(
    "Scheduler profiles use deploy/compose/docker-compose.schedulers.yml as the single final compose file; do not combine external SpiceDB/Casdoor override files with this local stack.",
  );
}

function composeBase(
  profile: Profile,
  options: Pick<Options, "spicedbExternal" | "casdoorExternal">,
): string[] {
  const cmd = ["docker", "compose"];
  if (profile.key !== "demo") cmd.push("--project-directory", ".");
  if (profile.project) cmd.push("-p", profile.project);
  if (profile.envFile) cmd.push("--env-file", profile.envFile);
  for (const file of composeFiles(profile, options)) cmd.push("-f", file);
  return cmd;
}

function schedulerScriptArgs(
  profile: Profile,
  options: Pick<Options, "spicedbExternal" | "casdoorExternal">,
): string[] {
  const args = [composeFiles(profile, options).join(":")];
  if (profile.envFile) args.push(profile.envFile);
  return args;
}

function commandFor(profile: Profile, opts: Options): string[][] {
  const action = opts.action ?? "up";
  if (profile.schedulerSmoke && action === "up" && !opts.noVerify && opts.services.length === 0) {
    const envPrefix = opts.build ? ["env", "KQ_SCHEDULER_SMOKE_BUILD=true"] : [];
    return [
      [
        ...envPrefix,
        ...withEnvPrefix(profile, opts, [
          "bash",
          "deploy/schedulers/smoke.sh",
          ...schedulerScriptArgs(profile, opts),
        ]),
      ],
    ];
  }
  if (profile.schedulerSmoke && action === "verify") {
    return [
      withEnvPrefix(profile, opts, [
        "bash",
        "deploy/schedulers/verify-recognition.sh",
        ...schedulerScriptArgs(profile, opts),
      ]),
    ];
  }

  const base = composeBase(profile, opts);
  switch (action) {
    case "up": {
      const cmd = [...base, "up"];
      if (!opts.attach) cmd.push("-d");
      if (opts.build) cmd.push("--build");
      if (opts.recreate) cmd.push("--force-recreate");
      cmd.push(...opts.services);
      return [withEnvPrefix(profile, opts, cmd)];
    }
    case "down": {
      const cmd = [...base, "down"];
      if (opts.volumes) cmd.push("-v");
      return [withEnvPrefix(profile, opts, cmd)];
    }
    case "restart": {
      return [
        [...base, "down", ...(opts.volumes ? ["-v"] : [])],
        ...commandFor(profile, { ...opts, action: "up" }),
      ];
    }
    case "ps":
      return [withEnvPrefix(profile, opts, [...base, "ps"])];
    case "logs":
      return [
        withEnvPrefix(profile, opts, [
          ...base,
          "logs",
          ...(opts.follow ? ["-f"] : []),
          ...opts.services,
        ]),
      ];
    case "config":
      return [withEnvPrefix(profile, opts, [...base, "config"])];
    case "build":
      return [withEnvPrefix(profile, opts, [...base, "build", ...opts.services])];
    case "pull":
      return [withEnvPrefix(profile, opts, [...base, "pull", ...opts.services])];
    case "verify":
      throw new Error(`Profile "${profile.key}" does not define a verify action`);
  }
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printCommand(cmd: string[]): void {
  console.log(`$ ${cmd.map(quoteArg).join(" ")}`);
}

async function runCommand(cmd: string[], dryRun: boolean): Promise<number> {
  printCommand(cmd);
  if (dryRun) return 0;
  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  });
  return await proc.exited;
}

function printProfileSummary(profile: Profile, options: Options): void {
  console.log(`\nProfile: ${profile.key} - ${profile.label}`);
  console.log(profile.description);
  console.log(`Compose files: ${composeFiles(profile, options).join(", ")}`);
  if (profile.envFile) console.log(`Env file: ${profile.envFile}`);
  if (profile.project) console.log(`Compose project: ${profile.project}`);
  if (profile.heavy) console.log("Note: this profile may build or start heavier containers.");
  console.log("\nURLs:");
  for (const url of profile.urls) console.log(`  - ${url}`);
  console.log("");
}

async function main(): Promise<void> {
  let opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (!opts.profile) {
    if (!process.stdin.isTTY) {
      throw new Error("Interactive mode requires a TTY; pass --profile in scripts/CI.");
    }
    opts = await completeInteractive(opts);
  }
  if (!opts.action) opts.action = "up";
  const profile = PROFILES[opts.profile ?? "watch"];
  validateProfileOptions(profile, opts);
  printProfileSummary(profile, opts);
  const commands = commandFor(profile, {
    ...opts,
    profile: profile.key,
    action: opts.action ?? "up",
  });
  for (const cmd of commands) {
    const code = await runCommand(cmd, opts.dryRun);
    if (code !== 0) process.exit(code);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(usage());
    process.exit(1);
  });
}
