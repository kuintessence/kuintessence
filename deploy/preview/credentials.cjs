const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function credentialData(previous, namespace, password, hashPassword) {
  if (!/^kq-pr-[1-9][0-9]*$/.test(namespace)) throw new Error("Invalid preview namespace");
  if (password && (password.length < 24 || /[\r\n]/.test(password))) {
    throw new Error("PREVIEW_PASSWORD must be a single line with at least 24 characters");
  }
  const data = { ...previous };
  const encode = (value) => Buffer.from(value).toString("base64");
  const decode = (key) => data[key] ? Buffer.from(data[key], "base64").toString("utf8") : "";
  const ensure = (key, value) => { if (!data[key]) data[key] = encode(value); };
  ensure("JWT_SECRET", randomBytes(48).toString("hex"));
  ensure("POSTGRES_PASSWORD", randomBytes(32).toString("hex"));
  ensure("RUSTFS_SECRET_KEY", randomBytes(32).toString("hex"));
  ensure("NETDRIVE_ACCESS_KEY", "kq-data-market-committer");
  ensure("NETDRIVE_SECRET_KEY", randomBytes(32).toString("hex"));
  ensure("DATABASE_URL", `postgres://kq:${encodeURIComponent(decode("POSTGRES_PASSWORD"))}@${namespace}-postgres:5432/kuintessence`);
  const nextPassword = password || decode("PREVIEW_PASSWORD") || randomBytes(32).toString("base64url");
  if (!data.PREVIEW_HTPASSWD || nextPassword !== decode("PREVIEW_PASSWORD")) {
    data.PREVIEW_PASSWORD = encode(nextPassword);
    data.PREVIEW_HTPASSWD = encode(`preview:${hashPassword(nextPassword).trim()}\n`);
    data.PREVIEW_COOKIE = encode(randomBytes(32).toString("hex"));
  }
  ensure("PREVIEW_COOKIE", randomBytes(32).toString("hex"));
  return data;
}

function addTlsData(data, namespace) {
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
      "-out", "server.csr", "-subj", `/CN=${namespace}-server`);
    fs.writeFileSync(path.join(directory, "server.ext"), [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${namespace}-server,DNS:${namespace}-server.${namespace}.svc,DNS:${namespace}-server.${namespace}.svc.cluster.local`,
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

if (require.main === module) {
  try {
    const [source, target] = process.argv.slice(2);
    const previous = JSON.parse(fs.readFileSync(source, "utf8"));
    const namespace = process.env.PREVIEW_NAMESPACE;
    const data = credentialData(previous?.data, namespace, process.env.PREVIEW_PASSWORD,
      (password) => execFileSync("openssl", ["passwd", "-apr1", "-stdin"], {
        input: `${password}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }));
    addTlsData(data, namespace);
    fs.writeFileSync(target, JSON.stringify({
      apiVersion: "v1", kind: "Secret", type: "Opaque",
      metadata: { name: "kq-preview-secrets", namespace },
      data,
    }), { mode: 0o600 });
  } catch {
    console.error("Unable to prepare preview credentials; no credential values were logged.");
    process.exitCode = 1;
  }
}

module.exports = { credentialData, addTlsData };
