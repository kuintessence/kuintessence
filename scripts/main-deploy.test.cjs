const { describe, expect, test } = require("bun:test");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");
const { parse } = require("yaml");

const root = resolve(__dirname, "..");
const script = readFileSync(join(root, "deploy/main/remote.sh"), "utf8");
const revision = "a".repeat(40);

function deploy(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kq-main-deploy-test-"));
  const remote = join(directory, "remote");
  const runner = join(directory, "runner");
  const source = join(directory, "source");
  const bin = join(directory, "bin");
  for (const path of [remote, runner, source, bin]) mkdirSync(path);
  writeFileSync(join(source, "remote.sh"), script);
  if (!options.missingCompose) writeFileSync(join(source, "compose.yml"), "new compose");
  if (!options.noExample) writeFileSync(join(source, "env.example"), "new example");
  writeFileSync(join(remote, "compose.yml"), "old compose");
  writeFileSync(join(remote, "env.example"), "old example");
  writeFileSync(join(remote, ".env"), "existing secrets");
  const run = `#!/bin/sh\nprintf '%s' "$PWD" > deployed\nprintf '%s' "$*" > deployed-args\nexit ${options.runExit ?? 0}\n`;
  writeFileSync(join(remote, "run.sh"), run, { mode: options.missingExecutable ? 0o600 : 0o700 });
  writeFileSync(
    join(bin, "ssh"),
    `#!/usr/bin/env bun
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const key = args[args.indexOf("-i") + 1];
fs.writeFileSync(process.env.CALL_FILE, JSON.stringify({
  args, keyMode: fs.statSync(key).mode & 0o777,
  keyUnset: !Object.hasOwn(process.env, "MAIN_SSH_KEY"),
}));
const input = fs.readFileSync(0);
if (process.env.FAIL_SSH === "true") process.exit(255);
let command = args.at(-1).replaceAll("/opt/deploy", process.env.REMOTE_DIR);
if (process.env.CORRUPT_IMAGE === "true") command = command.replace("sha256sum --check images.sha256", "printf x >> images.tar.gz; sha256sum --check images.sha256");
const result = spawnSync("sh", ["-c", command], {
  input: process.env.CORRUPT_ARCHIVE === "true" ? Buffer.from("invalid archive") : input,
  env: process.env, encoding: "utf8",
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bun
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const args = process.argv.slice(2);
const remote = process.cwd() === process.env.REMOTE_DIR;
if (args[0] === "pull") process.exit(process.env.FAIL_PULL === "true" ? 1 : 0);
if (args[0] === "save") {
  if (process.env.FAIL_SAVE === "true") process.exit(1);
  process.stdout.write(JSON.stringify(args.slice(1)));
} else if (args[0] === "load") {
  if (!remote || process.env.FAIL_LOAD === "true") process.exit(1);
  const images = JSON.parse(gunzipSync(fs.readFileSync(args[2])));
  const expected = ["server", "registry", "web", "db-migrate"].map(name => "ghcr.io/example/kuintessence-" + name + ":main");
  if (JSON.stringify(images) !== JSON.stringify(expected)) process.exit(1);
  fs.writeFileSync(process.env.LOAD_FILE, "loaded");
} else if (args[0] === "image" && args[1] === "inspect") {
  if (args[3] === "{{.Id}}") {
    if (!remote && process.env.FAIL_IMAGE_INSPECT === "true") process.exit(1);
    const identity = createHash("sha256").update(args.at(-1)).digest("hex");
    process.stdout.write("sha256:" + (remote && process.env.WRONG_IMAGE_ID === "true" ? "b".repeat(64) : identity));
  } else {
    const revision = process.env.WRONG_REVISION === "true" ? "b".repeat(40) : process.env.GITHUB_SHA;
    process.stdout.write("linux/" + (process.env.WRONG_PLATFORM === "true" ? "arm64" : "amd64") + " " + revision + " https://github.com/example/kuintessence");
  }
} else { process.exit(1); }
`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync("bash", [join(source, "remote.sh")], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: revision,
        GITHUB_REPOSITORY: "example/kuintessence",
        RUNNER_TEMP: runner,
        MAIN_SSH_HOST: "deploy.example.com",
        MAIN_SSH_PORT: "2222",
        MAIN_SSH_USER: "deploy",
        MAIN_SSH_KEY: "mock-private-key",
        CALL_FILE: join(directory, "call.json"),
        REMOTE_DIR: remote,
        FAIL_SSH: String(options.failSSH ?? false),
        CORRUPT_ARCHIVE: String(options.corruptArchive ?? false),
        LOAD_FILE: join(directory, "image-load"),
        ...options.env,
      },
    });
    const files = Object.fromEntries(
      readdirSync(remote).map((name) => [name, readFileSync(join(remote, name), "utf8")]),
    );
    const call = readdirSync(directory).includes("call.json")
      ? JSON.parse(readFileSync(join(directory, "call.json"), "utf8"))
      : undefined;
    return {
      ...result,
      files,
      call,
      remote,
      run,
      imagesLoaded: readdirSync(directory).includes("image-load"),
      temporaryFiles: readdirSync(runner),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("main SSH deployment", () => {
  test("replaces deployment files, preserves site state, then invokes the existing script", () => {
    const result = deploy();
    expect(result.status).toBe(0);
    expect(result.files).toEqual({
      "compose.yml": "new compose",
      "env.example": "new example",
      ".env": "existing secrets",
      "run.sh": result.run,
      deployed: result.remote,
      "deployed-args": `deploy --expected-revision ${revision}`,
    });
    expect(result.imagesLoaded).toBe(true);
    expect(result.call.keyMode).toBe(0o600);
    expect(result.call.keyUnset).toBe(true);
    expect(result.call.args).toContain("2222");
    expect(result.call.args).toContain("StrictHostKeyChecking=accept-new");
    expect(result.temporaryFiles).toEqual([]);
    expect(result.stdout + result.stderr).not.toContain("mock-private-key");
  });

  test("an absent optional example leaves the existing example untouched", () => {
    const result = deploy({ noExample: true });
    expect(result.status).toBe(0);
    expect(result.files["env.example"]).toBe("old example");
    expect(result.files.deployed).toBe(result.remote);
  });

  test.each([
    { failSSH: true },
    { corruptArchive: true },
    { missingExecutable: true },
  ])("connection, transfer and remote prerequisite errors prevent deployment: %j", (options) => {
    const result = deploy(options);
    expect(result.status).not.toBe(0);
    expect(result.files["compose.yml"]).toBe("old compose");
    expect(result.files.deployed).toBeUndefined();
    expect(result.temporaryFiles).toEqual([]);
  });

  test("remote deployment failure propagates to the job", () => {
    const result = deploy({ runExit: 42 });
    expect(result.status).toBe(42);
    expect(result.files.deployed).toBe(result.remote);
    expect(result.temporaryFiles).toEqual([]);
  });

  test.each([
    { GITHUB_EVENT_NAME: "release" },
    { GITHUB_REF: "refs/heads/feature" },
    { MAIN_SSH_HOST: "host;command" },
    { MAIN_SSH_USER: "-root" },
    { MAIN_SSH_PORT: "0" },
    { MAIN_SSH_PORT: "65536" },
    { MAIN_SSH_PORT: "" },
    { MAIN_SSH_KEY: "" },
    { GITHUB_SHA: "main" },
    { GITHUB_REPOSITORY: "owner/repo;command" },
  ])("rejects invalid deployment context before SSH: %j", (env) => {
    const result = deploy({ env });
    expect(result.status).not.toBe(0);
    expect(result.call).toBeUndefined();
    expect(result.files.deployed).toBeUndefined();
  });

  test("missing Compose fails before connecting", () => {
    expect(deploy({ missingCompose: true }).call).toBeUndefined();
  });

  test.each([
    "FAIL_PULL",
    "FAIL_SAVE",
    "FAIL_IMAGE_INSPECT",
    "WRONG_REVISION",
    "WRONG_PLATFORM",
  ])("%s prevents transfer of an invalid or incomplete build", (name) => {
    const result = deploy({ env: { [name]: "true" } });
    expect(result.status).not.toBe(0);
    expect(result.call).toBeUndefined();
    expect(result.files.deployed).toBeUndefined();
    expect(result.temporaryFiles).toEqual([]);
  });

  test.each([
    "CORRUPT_IMAGE",
    "FAIL_LOAD",
    "WRONG_IMAGE_ID",
  ])("%s prevents configuration replacement and deployment", (name) => {
    const result = deploy({ env: { [name]: "true" } });
    expect(result.status).not.toBe(0);
    expect(result.files["compose.yml"]).toBe("old compose");
    expect(result.files.deployed).toBeUndefined();
    if (name === "CORRUPT_IMAGE") expect(result.imagesLoaded).toBe(false);
    expect(result.temporaryFiles).toEqual([]);
  });
});

describe("main deployment wiring", () => {
  test("deploys the built commit only after all images succeed on a main push", () => {
    const workflow = parse(readFileSync(join(root, ".github/workflows/build-images.yml"), "utf8"));
    const job = workflow.jobs["deploy-main"];
    expect(job.needs).toBe("images");
    expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(job.steps[0].with.ref).toBe(`\${{ github.sha }}`);
    expect(job.permissions.packages).toBe("read");
    const login = job.steps.find((entry) => entry.uses === "docker/login-action@v3");
    expect(login.with.registry).toBe("ghcr.io");
    expect(login.with.password).toBe(`\${{ github.token }}`);
    const step = job.steps.find((entry) => entry.run === "bash deploy/main/remote.sh");
    for (const name of ["MAIN_SSH_HOST", "MAIN_SSH_PORT", "MAIN_SSH_USER", "MAIN_SSH_KEY"]) {
      expect(step.env[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  test("standalone Compose pulls all four main images and persists application state", () => {
    const compose = parse(readFileSync(join(root, "deploy/main/compose.yml"), "utf8"));
    for (const name of ["server", "registry", "web", "db-migrate"]) {
      expect(compose.services[name].image).toBe(
        `ghcr.io/\${KQ_IMAGE_OWNER:-kuintessence}/kuintessence-${name}:main`,
      );
      expect(compose.services[name].pull_policy).toBe("always");
    }
    for (const service of Object.values(compose.services)) {
      expect(service.build).toBeUndefined();
      expect(service.extends).toBeUndefined();
      expect(service.env_file).toBeUndefined();
      for (const volume of service.volumes ?? []) expect(volume).not.toMatch(/^[./]/);
    }
    expect(compose.services.server.environment.NODE_ENV).toBe("production");
    expect(compose.services.server.environment.AUTHZ_MODE).toBe("enforce");
    expect(compose.services.server.depends_on["db-migrate"].condition).toBe(
      "service_completed_successfully",
    );
    expect(compose.services.registry.depends_on["db-migrate"].condition).toBe(
      "service_completed_successfully",
    );
    expect(Object.keys(compose.volumes)).toContain("server-ca");
  });

  test("the environment example documents every required Compose variable", () => {
    const source = readFileSync(join(root, "deploy/main/compose.yml"), "utf8");
    const example = readFileSync(join(root, "deploy/main/env.example"), "utf8");
    const keys = new Set([...example.matchAll(/^([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]));
    for (const match of source.matchAll(/\$\{([A-Z_][A-Z0-9_]*):\?/g)) {
      expect(keys.has(match[1])).toBe(true);
    }
    expect(example).toContain("JWT_SECRET=\n");
    expect(example).toContain("POSTGRES_PASSWORD=\n");
    expect(example).toContain("RUSTFS_SECRET_KEY=\n");
  });
});
