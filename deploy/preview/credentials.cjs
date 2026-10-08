const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function validateCredentials(user, password) {
  if (typeof user !== "string" || user.length > 64 || !/^[A-Za-z0-9]/.test(user) || /[^A-Za-z0-9_.@-]/.test(user)) {
    throw new Error("PREVIEW_USER must be 1-64 characters, start with a letter or digit, and contain only letters, digits, _, ., @ or -");
  }
  if (typeof password !== "string" || password.length < 24 || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error("PREVIEW_PASSWORD must contain at least 24 characters and no control characters");
  }
}

function credentialData(previous, release, user, password, hashPassword) {
  if (!/^kq-pr-[1-9][0-9]{0,14}$/.test(release)) throw new Error("Invalid preview release");
  validateCredentials(user, password);
  const data = { ...previous };
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (key) => data[key] ? Buffer.from(data[key], "base64").toString("utf8") : "";
  const ensure = (key, value) => { if (!data[key]) data[key] = encode(value); };
  ensure("JWT_SECRET", randomBytes(48).toString("hex"));
  ensure("POSTGRES_PASSWORD", randomBytes(32).toString("hex"));
  ensure("RUSTFS_SECRET_KEY", randomBytes(32).toString("hex"));
  ensure("NETDRIVE_ACCESS_KEY", "kq-data-market-committer");
  ensure("NETDRIVE_SECRET_KEY", randomBytes(32).toString("hex"));
  ensure("DATABASE_URL", `postgres://kq:${encodeURIComponent(decode("POSTGRES_PASSWORD"))}@${release}-postgres:5432/kuintessence`);
  if (!data.PREVIEW_HTPASSWD || user !== decode("PREVIEW_USER") || password !== decode("PREVIEW_PASSWORD")) {
    data.PREVIEW_USER = encode(user);
    data.PREVIEW_PASSWORD = encode(password);
    data.PREVIEW_HTPASSWD = encode(`${user}:${hashPassword(password).trim()}\n`);
    data.PREVIEW_COOKIE = encode(randomBytes(32).toString("hex"));
  }
  ensure("PREVIEW_COOKIE", randomBytes(32).toString("hex"));
  return data;
}

function addTlsData(data, release) {
  if (!/^kq-pr-[1-9][0-9]{0,14}$/.test(release)) throw new Error("Invalid preview release");
  const keys = ["SERVER_CA_CERT", "SERVER_CA_KEY", "SERVER_TLS_CERT", "SERVER_TLS_KEY"];
  const present = keys.filter((key) => Boolean(data[key]));
  if (present.length === keys.length) return;
  if (present.length) throw new Error("Incomplete preview PKI; refusing to regenerate");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kq-preview-pki-"));
  const run = (...args) => execFileSync("openssl", args, {
    cwd: directory, stdio: ["ignore", "ignore", "ignore"], timeout: 60000,
  });
  try {
    run("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650",
      "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Kuintessence Preview CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
      "-out", "server.csr", "-subj", `/CN=${release}-server`);
    fs.writeFileSync(path.join(directory, "server.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${release}-server,DNS:${release}-server.preview.svc,DNS:${release}-server.preview.svc.cluster.local`,
    ].join("\n"), { mode: 0o600 });
    run("x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
      "-CAcreateserial", "-out", "server.crt", "-days", "365", "-sha256", "-extfile", "server.ext");
    for (const [index, file] of ["ca.crt", "ca.key", "server.crt", "server.key"].entries()) {
      data[keys[index]] = fs.readFileSync(path.join(directory, file)).toString("base64");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function credentialSecret(previous, pr, repository, user, password, hashPassword) {
  if (
    !/^[1-9][0-9]{0,14}$/.test(String(pr)) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository ?? "")
  ) throw new Error("Invalid preview credential identity");
  const release = `kq-pr-${pr}`;
  const metadata = {
    name: `${release}-secrets`,
    namespace: "preview",
    labels: {
      "app.kubernetes.io/managed-by": "kq-preview",
      "app.kubernetes.io/instance": release,
      "kuintessence.com/preview-pr": String(pr),
    },
    annotations: { "kuintessence.com/repository": repository },
  };
  if (previous !== null && previous !== undefined) {
    if (
      previous.kind !== "Secret" || previous.type !== "Opaque" ||
      previous.metadata?.name !== metadata.name ||
      previous.metadata?.namespace !== metadata.namespace ||
      !Object.entries(metadata.labels).every(([key, value]) => previous.metadata.labels?.[key] === value) ||
      previous.metadata.annotations?.["kuintessence.com/repository"] !== repository ||
      !previous.data || typeof previous.data !== "object" || Array.isArray(previous.data)
    ) throw new Error("Preview credential ownership mismatch");
  }
  const data = credentialData(previous?.data, release, user, password, hashPassword);
  addTlsData(data, release);
  return { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata, data };
}

if (require.main === module) {
  try {
    if (process.argv[2] === "validate") {
      validateCredentials(process.env.PREVIEW_USER, process.env.PREVIEW_PASSWORD);
    } else {
      const [source, target] = process.argv.slice(2);
      const previous = JSON.parse(fs.readFileSync(source, "utf8"));
      if (
        process.env.PREVIEW_NAMESPACE !== "preview" ||
        process.env.PREVIEW_RELEASE !== `kq-pr-${process.env.PREVIEW_PR}`
      ) throw new Error("Invalid preview scope");
      const secret = credentialSecret(previous, process.env.PREVIEW_PR,
        process.env.GITHUB_REPOSITORY, process.env.PREVIEW_USER, process.env.PREVIEW_PASSWORD,
        (password) => execFileSync("openssl", ["passwd", "-apr1", "-stdin"], {
          input: `${password}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }));
      fs.writeFileSync(target, JSON.stringify(secret), { mode: 0o600 });
    }
  } catch {
    console.error("Unable to prepare preview credentials; check PREVIEW_USER and PREVIEW_PASSWORD secrets. No credential values were logged.");
    process.exitCode = 1;
  }
}

module.exports = { validateCredentials, credentialData, addTlsData, credentialSecret };
