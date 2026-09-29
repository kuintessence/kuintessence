const fs = require("node:fs");

const details = new WeakMap();
const ERROR_CODES = new Map([
  ["ENOTFOUND", "DNS_NOT_FOUND"], ["EAI_AGAIN", "DNS_TEMPORARY_FAILURE"],
  ["EAI_FAIL", "DNS_RESOLVER_FAILURE"],
  ["CERT_HAS_EXPIRED", "TLS_CERT_EXPIRED"],
  ["CERT_NOT_YET_VALID", "TLS_CERT_NOT_YET_VALID"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_HOSTNAME_MISMATCH"],
  ...["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].map((code) => [code, "TLS_SELF_SIGNED"]),
  ...["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].map((code) => [code, "TLS_UNTRUSTED"]),
  ["ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "TLS_HANDSHAKE_FAILURE"],
  ["ERR_TLS_HANDSHAKE_TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"],
  ...["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
    "UND_ERR_SOCKET"].map((code) => [code, "CONNECTION_FAILURE"]),
  ...["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT"].map((code) => [code, "TIMEOUT"]),
  ["ABORT_ERR", "ABORTED"], ["ENOENT", "FILE_MISSING"], ["EACCES", "FILE_DENIED"],
  ["EIO", "FILE_READ_FAILED"],
]);
const ERROR_NAMES = new Map([["TimeoutError", "TIMEOUT"], ["AbortError", "ABORTED"]]);
const STAGES = new Set([
  "INPUT", "ANONYMOUS", "ANONYMOUS_LOCATION", "CHALLENGE", "UNLOCK", "COOKIE",
  "WEB", "WEB_HTML", "HEALTH", "COMPLETE", "UNKNOWN",
]);
const CODES = new Set([
  ...ERROR_CODES.values(), ...ERROR_NAMES.values(), "OK", "UNKNOWN", "HTTP_STATUS",
  "LOCATION_MISMATCH", "COOKIE_MISMATCH", "CONTENT_TYPE_MISMATCH",
  "INVALID_PR", "INVALID_JSON", "RETRIES_EXHAUSTED",
]);

function errorCode(error) {
  const seen = new Set();
  for (let depth = 0; depth < 5 && error && typeof error === "object" && !seen.has(error); depth++) {
    seen.add(error);
    try {
      const code = ERROR_CODES.get(error.code) ?? ERROR_NAMES.get(error.name);
      if (code) return code;
      error = error.cause;
    } catch {
      return "UNKNOWN";
    }
  }
  return "UNKNOWN";
}

function failure(stage, code, message, status) {
  const error = new Error(message);
  details.set(error, { stage, code, status });
  return error;
}

function line(stage, code, attempt, status) {
  const fields = [
    `KQ_PREVIEW_HTTPS stage=${STAGES.has(stage) ? stage : "UNKNOWN"}`,
    `code=${CODES.has(code) ? code : "UNKNOWN"}`,
  ];
  if (Number.isInteger(status) && status >= 100 && status <= 599) fields.push(`status=${status}`);
  if (Number.isInteger(attempt) && attempt >= 1 && attempt <= 12) fields.push(`attempt=${attempt}`);
  return fields.join(" ");
}

function diagnosticLine(error, attempt) {
  const known = details.get(error);
  return line(known?.stage ?? "UNKNOWN", known?.code ?? errorCode(error), attempt, known?.status);
}

async function acceptance(origin, password, cookie, request, report) {
  const options = () => ({ redirect: "manual", signal: AbortSignal.timeout(15000) });
  let stage = "ANONYMOUS";
  let status;
  const get = async (url, init) => {
    status = undefined;
    const response = await request(url, init);
    status = response?.status;
    return response;
  };
  const check = (passes, code, message) => {
    if (!passes) throw failure(stage, code, message, status);
    report(stage, status);
  };
  try {
    const anonymous = await get(origin, options());
    check(anonymous.status === 302, "HTTP_STATUS", "Anonymous preview requests must be gated");
    stage = "ANONYMOUS_LOCATION";
    check(anonymous.headers.get("location") === "/__preview/unlock",
      "LOCATION_MISMATCH", "Anonymous preview requests must be gated");
    stage = "CHALLENGE";
    const challenge = await get(`${origin}/__preview/unlock`, options());
    check(challenge.status === 401, "HTTP_STATUS", "Preview unlock must require authentication");
    stage = "UNLOCK";
    const unlock = await get(`${origin}/__preview/unlock`, {
      ...options(), headers: { Authorization: `Basic ${Buffer.from(`preview:${password}`).toString("base64")}` },
    });
    check(unlock.status === 200, "HTTP_STATUS", "Preview unlock did not issue its secure cookie");
    stage = "COOKIE";
    check(unlock.headers.get("set-cookie")?.includes(`kq_preview=${cookie};`),
      "COOKIE_MISMATCH", "Preview unlock did not issue its secure cookie");
    const headers = { Cookie: `kq_preview=${cookie}` };
    stage = "WEB";
    const home = await get(origin, { ...options(), headers });
    check(home.status === 200, "HTTP_STATUS", "Preview Web is unavailable");
    stage = "WEB_HTML";
    check(home.headers.get("content-type")?.includes("text/html"),
      "CONTENT_TYPE_MISMATCH", "Preview Web is unavailable");
    stage = "HEALTH";
    const health = await get(`${origin}/api/health`, { ...options(), headers });
    check(health.status === 200, "HTTP_STATUS", "Preview Server is unavailable");
  } catch (error) {
    if (details.has(error)) throw error;
    throw failure(stage, errorCode(error), "Preview HTTPS request failed", status);
  }
}

async function verifyHttps(origin, password, cookie, request = fetch) {
  await acceptance(origin, password, cookie, request, () => {});
}

async function runCLI(args, env = process.env, {
  request = fetch, files = fs, emit = console.log,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let secret;
  try {
    if (!/^[1-9][0-9]{0,14}$/.test(env.PREVIEW_PR ?? "")) {
      throw failure("INPUT", "INVALID_PR", "Invalid PR");
    }
    secret = JSON.parse(files.readFileSync(args[0], "utf8"));
  } catch (error) {
    emit(details.has(error) ? diagnosticLine(error) :
      line("INPUT", error instanceof SyntaxError ? "INVALID_JSON" : errorCode(error)));
    return false;
  }
  const origin = `https://pr-${env.PREVIEW_PR}.preview.dev.kuintessence.com`;
  for (let attempt = 1; attempt <= 12; attempt++) {
    // Preserve the original per-attempt decoding and the delay after every failed attempt.
    const decode = (key) => Buffer.from(secret.data[key], "base64").toString("utf8");
    try {
      let password;
      let cookie;
      try {
        password = decode("PREVIEW_PASSWORD");
        cookie = decode("PREVIEW_COOKIE");
      } catch (error) {
        throw failure("INPUT", errorCode(error), "Unable to decode preview credentials");
      }
      await acceptance(origin, password, cookie, request,
        (stage, status) => emit(line(stage, "OK", attempt, status)));
      emit(line("COMPLETE", "OK", attempt));
      return true;
    } catch (error) {
      emit(diagnosticLine(error, attempt));
      await sleep(5000);
    }
  }
  emit(line("COMPLETE", "RETRIES_EXHAUSTED", 12));
  return false;
}

if (require.main === module) {
  runCLI(process.argv.slice(2)).then((ready) => {
    if (!ready) process.exitCode = 1;
  }).catch((error) => {
    console.error(diagnosticLine(error));
    process.exitCode = 1;
  });
}

module.exports = { verifyHttps, errorCode, diagnosticLine, runCLI };
