const fs = require("node:fs");
const { positiveInteger } = require("./gate.cjs");

const COMPONENTS = ["server", "registry", "web", "db-migrate", "seed", "scheduler"];
const TAG = /^pr-([1-9][0-9]{0,14})-sha-([a-f0-9]{40})-run-([1-9][0-9]{0,14})-([1-9][0-9]{0,14})$/;

function identifier(value, field) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Invalid ${field}`);
  const parsed = positiveInteger(value, field);
  if (String(parsed) !== String(value)) throw new Error(`Invalid ${field}`);
  return parsed;
}

function imageTag(pr, revision, run, attempt) {
  if (typeof revision !== "string" || revision.length !== 40 || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Invalid image revision");
  }
  return `pr-${identifier(pr, "PR")}-sha-${revision}-run-${identifier(run, "run")}-${identifier(attempt, "attempt")}`;
}

function matchesPRTag(tag, pr) {
  const expected = identifier(pr, "PR");
  if (typeof tag !== "string") return false;
  const match = TAG.exec(tag);
  if (!match || tag !== imageTag(match[1], match[2], match[3], match[4])) return false;
  return Number(match[1]) === expected;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectedTag(owner, revision, context) {
  if (typeof owner !== "string" || owner.trim() !== owner || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) {
    throw new Error("Invalid image owner");
  }
  if (!record(context)) throw new Error("Image identity context is required");
  return imageTag(context.pr, revision, context.run, context.attempt);
}

function imagesFromMetadata(metadata, owner, revision, context) {
  const tag = expectedTag(owner, revision, context);
  if (!record(metadata)) throw new Error("Invalid image metadata");
  return Object.fromEntries(COMPONENTS.map((name) => {
    const digest = metadata[name]?.["containerimage.digest"];
    if (typeof digest !== "string" || digest.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Missing ${name} image digest`);
    }
    const repository = `ghcr.io/${owner}/kq-dev-${name}`;
    const publishedName = metadata[name]?.["image.name"];
    if (publishedName !== undefined && publishedName !== `${repository}:${tag}`) {
      throw new Error(`Unexpected ${name} published image identity`);
    }
    return [name, {
      repository,
      tag,
      digest,
      pullPolicy: "IfNotPresent",
    }];
  }));
}

function validateImages(images, owner, revision, context) {
  if (!record(images) || Object.keys(images).length !== COMPONENTS.length ||
      !COMPONENTS.every((name) => Object.hasOwn(images, name))) {
    throw new Error("Image manifest must contain exactly the six preview components");
  }
  const metadata = Object.fromEntries(COMPONENTS.map((name) =>
    [name, { "containerimage.digest": images[name]?.digest }],
  ));
  const expected = imagesFromMetadata(metadata, owner, revision, context);
  for (const name of COMPONENTS) {
    const image = images[name];
    if (!record(image) || Object.keys(image).length !== 4 ||
        !Object.entries(expected[name]).every(([key, value]) => Object.hasOwn(image, key) && image[key] === value)) {
      throw new Error("Image manifest does not match the expected PR, SHA, run, publish attempt and GHCR names");
    }
  }
  return expected;
}

async function verifyPull(images, username, password, request = fetch) {
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("Registry authentication requires both username and password");
  }
  for (const image of Object.values(images)) {
    const name = image.repository.replace(/^ghcr.io\//, "");
    const params = new URLSearchParams({ service: "ghcr.io", scope: `repository:${name}:pull` });
    const headers = password
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      : {};
    const response = await request(`https://ghcr.io/token?${params}`, {
      headers, signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!response.ok) throw new Error("GHCR pull denied: make all six kq-dev packages public, then rerun failed jobs");
    const data = await response.json();
    if (typeof data?.token !== "string" || !data.token) throw new Error("Invalid GHCR pull authorization");
    const manifest = await request(`https://ghcr.io/v2/${name}/manifests/${image.tag}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${data.token}`,
        Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!manifest.ok) throw new Error("GHCR image is not pullable: make all six kq-dev packages public, then rerun failed jobs");
    if (manifest.headers.get("docker-content-digest") !== image.digest) {
      throw new Error("GHCR tag digest does not match the validated publish identity");
    }
  }
}

async function runCLI(args, env = process.env, files = fs, request = fetch) {
  const [mode, source, target] = args;
  if (mode !== "collect" && mode !== "verify") throw new Error("Invalid image manifest operation");
  const context = { pr: env.PREVIEW_PR, run: env.PREVIEW_RUN, attempt: env.PREVIEW_ATTEMPT };
  const input = JSON.parse(files.readFileSync(source, "utf8"));
  const images = mode === "collect"
    ? imagesFromMetadata(input, env.IMAGE_OWNER, env.PREVIEW_SHA, context)
    : validateImages(input, env.IMAGE_OWNER, env.PREVIEW_SHA, context);
  if (mode === "collect") {
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required when collecting images");
    files.writeFileSync(target, JSON.stringify(images), { mode: 0o600 });
    files.appendFileSync(env.GITHUB_OUTPUT, `attempt=${identifier(context.attempt, "attempt")}\n`);
  } else {
    // Public-only CLI: a temporary or persistent runner credential must not hide
    // packages that Kubernetes cannot pull anonymously.
    await verifyPull(images, undefined, undefined, request);
  }
  return images;
}

if (require.main === module) {
  runCLI(process.argv.slice(2)).catch(() => {
    console.error("GHCR image verification failed. Check PR/SHA/run/publish-attempt identity and digests; make all six kq-dev packages public, then rerun failed jobs.");
    process.exitCode = 1;
  });
}

module.exports = { COMPONENTS, imageTag, matchesPRTag, imagesFromMetadata, validateImages, verifyPull, runCLI };
