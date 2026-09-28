const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { validateImages } = require("./images.cjs");

function previewValues(images, pr, owner, sha, privatePull) {
  if (!/^[1-9][0-9]{0,14}$/.test(pr)) throw new Error("Invalid PR");
  validateImages(images, owner, sha);
  const values = {
    global: {
      nodeSelector: { "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux" },
      imagePullSecrets: privatePull ? [{ name: "kq-preview-ghcr" }] : [],
    },
    secrets: { existingSecret: "kq-preview-secrets" },
    preview: { host: `pr-${pr}.preview.dev.kuintessence.com` },
  };
  for (const [name, image] of Object.entries(images)) {
    values[name === "db-migrate" ? "migration" : name] = { image };
  }
  return { "kq-platform": values };
}

if (require.main === module) {
  try {
    const [mode, target] = process.argv.slice(2);
    let result;
    if (mode === "values") {
      const images = JSON.parse(fs.readFileSync(process.env.IMAGE_MANIFEST, "utf8"));
      result = previewValues(images, process.env.PREVIEW_PR, process.env.IMAGE_OWNER,
        process.env.PREVIEW_SHA, Boolean(process.env.GHCR_PULL_TOKEN));
      const secret = JSON.parse(fs.readFileSync(process.env.PREVIEW_SECRET_FILE, "utf8"));
      result["kq-platform"].preview.credentialsRevision = createHash("sha256")
        .update(secret.data.PREVIEW_COOKIE).digest("hex");
    } else if (mode === "registry-secret") {
      if (!/^kq-pr-[1-9][0-9]*$/.test(process.env.PREVIEW_NAMESPACE ?? "") ||
          !process.env.GHCR_PULL_USER || !process.env.GHCR_PULL_TOKEN) {
        throw new Error("Missing private registry credentials");
      }
      const auth = Buffer.from(`${process.env.GHCR_PULL_USER}:${process.env.GHCR_PULL_TOKEN}`).toString("base64");
      result = {
        apiVersion: "v1", kind: "Secret", type: "kubernetes.io/dockerconfigjson",
        metadata: { name: "kq-preview-ghcr", namespace: process.env.PREVIEW_NAMESPACE },
        data: {
          ".dockerconfigjson": Buffer.from(JSON.stringify({ auths: { "ghcr.io": { auth } } })).toString("base64"),
        },
      };
    } else throw new Error("Invalid values operation");
    fs.writeFileSync(target, JSON.stringify(result), { mode: 0o600 });
  } catch {
    console.error("Unable to construct validated preview values or registry credentials.");
    process.exitCode = 1;
  }
}

module.exports = { previewValues };
