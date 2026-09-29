const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { validateImages } = require("./images.cjs");

function previewValues(images, pr, owner, sha, context) {
  const validated = validateImages(images, owner, sha, {
    pr, run: context?.run, attempt: context?.attempt,
  });
  const values = {
    global: {
      nodeSelector: { "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux" },
      imagePullSecrets: [],
    },
    secrets: { existingSecret: "kq-preview-secrets" },
    preview: { host: `pr-${pr}.preview.dev.kuintessence.com` },
  };
  for (const [name, image] of Object.entries(validated)) {
    values[name === "db-migrate" ? "migration" : name] = { image };
  }
  return { "kq-platform": values };
}

if (require.main === module) {
  try {
    const [mode, target] = process.argv.slice(2);
    if (mode !== "values") throw new Error("Invalid values operation");
    const images = JSON.parse(fs.readFileSync(process.env.IMAGE_MANIFEST, "utf8"));
    const result = previewValues(images, process.env.PREVIEW_PR, process.env.IMAGE_OWNER,
      process.env.PREVIEW_SHA, {
        run: process.env.PREVIEW_RUN, attempt: process.env.PREVIEW_ATTEMPT,
      });
    const secret = JSON.parse(fs.readFileSync(process.env.PREVIEW_SECRET_FILE, "utf8"));
    result["kq-platform"].preview.credentialsRevision = createHash("sha256")
      .update(secret.data.PREVIEW_COOKIE).digest("hex");
    fs.writeFileSync(target, JSON.stringify(result), { mode: 0o600 });
  } catch {
    console.error("Unable to construct preview values for the expected PR/SHA/run/publish attempt.");
    process.exitCode = 1;
  }
}

module.exports = { previewValues };
