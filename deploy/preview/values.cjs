const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { validateImages } = require("./images.cjs");

function previewValues(images, pr, owner, sha, context) {
  const validated = validateImages(images, owner, sha, {
    pr, run: context?.run, attempt: context?.attempt,
  });
  const repository = context?.repository;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split("/")[0].toLowerCase() !== owner
  ) throw new Error("Preview repository must match the image owner");
  const values = {
    global: {
      nodeSelector: { "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux" },
      imagePullSecrets: [],
    },
    secrets: { existingSecret: `kq-pr-${pr}-secrets` },
    preview: { host: `pr-${pr}.preview.dev.kuintessence.com`, repository },
  };
  for (const [name, image] of Object.entries(validated)) {
    values[name === "db-migrate" ? "migration" : name] = { image };
  }
  return { "kq-platform": values };
}

function runCLI(args, env = process.env, files = fs) {
  const [mode, target] = args;
  if (mode !== "values" || !target) throw new Error("Invalid values operation");
  const images = JSON.parse(files.readFileSync(env.IMAGE_MANIFEST, "utf8"));
  const result = previewValues(images, env.PREVIEW_PR, env.IMAGE_OWNER,
    env.PREVIEW_SHA, {
      run: env.PREVIEW_RUN, attempt: env.PREVIEW_ATTEMPT,
      repository: env.GITHUB_REPOSITORY,
    });
  const secret = JSON.parse(files.readFileSync(env.PREVIEW_SECRET_FILE, "utf8"));
  result["kq-platform"].preview.credentialsRevision = createHash("sha256")
    .update(secret.data.PREVIEW_COOKIE).digest("hex");
  files.writeFileSync(target, JSON.stringify(result), { mode: 0o600 });
}

if (require.main === module) {
  try {
    runCLI(process.argv.slice(2));
  } catch {
    console.error("Unable to construct preview values for the expected PR/SHA/run/publish attempt.");
    process.exitCode = 1;
  }
}

module.exports = { previewValues, runCLI };
