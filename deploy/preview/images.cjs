const fs = require("node:fs");

const COMPONENTS = ["server", "registry", "web", "db-migrate", "seed", "scheduler"];

function imagesFromMetadata(metadata, owner, revision) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(owner) || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Invalid image owner or revision");
  }
  return Object.fromEntries(COMPONENTS.map((name) => {
    const digest = metadata[name]?.["containerimage.digest"];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`Missing ${name} image digest`);
    return [name, {
      repository: `ghcr.io/${owner}/kq-dev-${name}`,
      tag: `sha-${revision}`,
      digest,
      pullPolicy: "IfNotPresent",
    }];
  }));
}

function validateImages(images, owner, revision) {
  const metadata = Object.fromEntries(COMPONENTS.map((name) =>
    [name, { "containerimage.digest": images[name]?.digest }],
  ));
  const expected = imagesFromMetadata(metadata, owner, revision);
  if (JSON.stringify(images) !== JSON.stringify(expected)) {
    throw new Error("Image manifest does not match the tested SHA and expected GHCR names");
  }
  return expected;
}

async function verifyPull(images, username, password) {
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("Set both GHCR_PULL_USER and GHCR_PULL_TOKEN for private images");
  }
  for (const image of Object.values(images)) {
    const name = image.repository.replace(/^ghcr.io\//, "");
    const params = new URLSearchParams({ service: "ghcr.io", scope: `repository:${name}:pull` });
    const headers = password
      ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
      : {};
    const response = await fetch(`https://ghcr.io/token?${params}`, {
      headers, signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!response.ok) throw new Error("GHCR pull denied: make kq-dev packages public or configure a persistent read:packages credential");
    const data = await response.json();
    if (typeof data.token !== "string") throw new Error("Invalid GHCR pull authorization");
    const manifest = await fetch(`https://ghcr.io/v2/${name}/manifests/${image.digest}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${data.token}`,
        Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!manifest.ok) throw new Error("GHCR image is not pullable with the configured persistent credentials");
  }
}

if (require.main === module) {
  const [mode, source, target] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    const input = JSON.parse(fs.readFileSync(source, "utf8"));
    const images = mode === "collect"
      ? imagesFromMetadata(input, process.env.IMAGE_OWNER, process.env.PREVIEW_SHA)
      : validateImages(input, process.env.IMAGE_OWNER, process.env.PREVIEW_SHA);
    if (mode === "collect") fs.writeFileSync(target, JSON.stringify(images), { mode: 0o600 });
    else if (mode === "verify") await verifyPull(images, process.env.GHCR_PULL_USER, process.env.GHCR_PULL_TOKEN);
    else throw new Error("Invalid image manifest operation");
  }).catch(() => {
    console.error("GHCR image verification failed. Check immutable digests and public visibility or GHCR_PULL_USER/GHCR_PULL_TOKEN.");
    process.exitCode = 1;
  });
}

module.exports = { COMPONENTS, imagesFromMetadata, validateImages, verifyPull };
