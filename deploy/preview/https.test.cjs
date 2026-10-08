const { describe, expect, test } = require("bun:test");
const { verifyHttps, errorCode, diagnosticLine, runCLI } = require("./https.cjs");

const origin = "https://private-preview.example.test";
const user = "PRIVATE_USER_canary";
const password = "PRIVATE_PASSWORD_canary";
const cookie = "PRIVATE_COOKIE_canary";
const privateText = "PRIVATE_message_header_url_certificate_canary";
const env = { PREVIEW_PR: "17" };
const secret = JSON.stringify({ data: {
  PREVIEW_USER: Buffer.from(user).toString("base64"),
  PREVIEW_PASSWORD: Buffer.from(password).toString("base64"),
  PREVIEW_COOKIE: Buffer.from(cookie).toString("base64"),
} });

function responses() {
  return [
    { status: 302, headers: { location: "/__preview/unlock" } },
    { status: 401 },
    { status: 200, headers: { "set-cookie": `kq_preview=${cookie}; Path=/; Secure; HttpOnly` } },
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    { status: 200 },
  ];
}

function requester(values = responses()) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      const value = values[calls.length % values.length];
      calls.push({ url, options });
      if (value.error !== undefined) throw value.error;
      return {
        status: value.status,
        headers: { get: (name) => {
          if (value.headerError) throw value.headerError;
          return value.headers?.[name] ?? null;
        } },
        text: () => { throw new Error("Response body must never be read"); },
        json: () => { throw new Error("Response body must never be read"); },
      };
    },
  };
}

async function rejected(operation) {
  try { await operation(); } catch (error) { return error; }
  throw new Error("Expected rejection");
}

function assertSafe(output) {
  const text = output.join("\n");
  for (const value of [origin, user, password, cookie, privateText,
    Buffer.from(`${user}:${password}`).toString("base64")]) expect(text).not.toContain(value);
  for (const entry of output) {
    expect(entry).toMatch(/^KQ_PREVIEW_HTTPS stage=[A-Z_]+ code=[A-Z_]+(?: status=[1-5][0-9]{2})?(?: attempt=(?:[1-9]|1[0-2]))?$/);
  }
}

describe("HTTPS acceptance stages", () => {
  test("retains five requests, manual redirects, bounded signals and exact credential routing", async () => {
    const server = requester();
    expect(await verifyHttps(origin, user, password, cookie, server.request)).toBeUndefined();
    expect(server.calls.map((call) => call.url)).toEqual([
      origin, `${origin}/__preview/unlock`, `${origin}/__preview/unlock`, origin, `${origin}/api/health`,
    ]);
    for (const { options } of server.calls) {
      expect(options.redirect).toBe("manual");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      expect(Object.keys(options).sort()).toEqual(
        options.headers ? ["headers", "redirect", "signal"] : ["redirect", "signal"],
      );
    }
    expect(new Set(server.calls.map((call) => call.options.signal)).size).toBe(5);
    expect(server.calls[0].options.headers).toBeUndefined();
    expect(server.calls[1].options.headers).toBeUndefined();
    expect(server.calls[2].options.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    });
    expect(server.calls[3].options.headers).toEqual({ Cookie: `kq_preview=${cookie}` });
    expect(server.calls[4].options.headers).toEqual({ Cookie: `kq_preview=${cookie}` });
  });

  test.each([
    [0, 200, undefined, "ANONYMOUS", "HTTP_STATUS"],
    [0, 302, { location: `https://${privateText}/` }, "ANONYMOUS_LOCATION", "LOCATION_MISMATCH"],
    [1, 403, undefined, "CHALLENGE", "HTTP_STATUS"],
    [2, 302, undefined, "UNLOCK", "HTTP_STATUS"],
    [2, 200, { "set-cookie": `${privateText};` }, "COOKIE", "COOKIE_MISMATCH"],
    [3, 503, undefined, "WEB", "HTTP_STATUS"],
    [3, 200, { "content-type": privateText }, "WEB_HTML", "CONTENT_TYPE_MISMATCH"],
    [4, 502, undefined, "HEALTH", "HTTP_STATUS"],
  ])("reports rejection at response %s as %s without response contents", async (index, status, headers, stage, code) => {
    const values = responses();
    values[index] = { status, headers };
    const server = requester(values);
    const error = await rejected(() => verifyHttps(origin, user, password, cookie, server.request));
    const output = [diagnosticLine(error, 3)];
    expect(output).toEqual([`KQ_PREVIEW_HTTPS stage=${stage} code=${code} status=${status} attempt=3`]);
    expect(server.calls).toHaveLength(index + 1);
    assertSafe(output);
  });

  test.each([0, 1, 2, 3, 4])("fetch cause at request %s retains its exact stage without stale HTTP status", async (index) => {
    const values = responses();
    values[index] = { error: new TypeError(privateText, { cause: { code: "ENOTFOUND", message: privateText } }) };
    const error = await rejected(() => verifyHttps(origin, user, password, cookie, requester(values).request));
    const stage = ["ANONYMOUS", "CHALLENGE", "UNLOCK", "WEB", "HEALTH"][index];
    const output = [diagnosticLine(error, 1)];
    expect(output).toEqual([`KQ_PREVIEW_HTTPS stage=${stage} code=DNS_NOT_FOUND attempt=1`]);
    expect(error.message).not.toContain(privateText);
    expect(error.cause).toBeUndefined();
    assertSafe(output);
  });

  test("throwing headers and malformed status cannot be interpolated into diagnostics", async () => {
    const values = responses();
    values[0].headerError = new Error(privateText);
    const headerError = await rejected(() => verifyHttps(origin, user, password, cookie, requester(values).request));
    expect(diagnosticLine(headerError)).toBe("KQ_PREVIEW_HTTPS stage=ANONYMOUS_LOCATION code=UNKNOWN status=302");
    for (const status of [privateText, 0, 600, 200.5, NaN, { toString: () => privateText }]) {
      const error = await rejected(() => verifyHttps(origin, user, password, cookie,
        requester([{ status, headers: { location: privateText } }]).request));
      expect(diagnosticLine(error, privateText)).toBe("KQ_PREVIEW_HTTPS stage=ANONYMOUS code=HTTP_STATUS");
    }
  });

  test("does not strengthen the existing cookie substring or HTML content-type acceptance", async () => {
    const values = responses();
    values[2].headers["set-cookie"] = `kq_preview=${cookie};`;
    values[3].headers["content-type"] = "text/html";
    await verifyHttps(origin, user, password, cookie, requester(values).request);
  });
});

describe("exception allowlist", () => {
  test.each([
    ["ENOTFOUND", "DNS_NOT_FOUND"], ["EAI_AGAIN", "DNS_TEMPORARY_FAILURE"],
    ["EAI_FAIL", "DNS_RESOLVER_FAILURE"],
    ["CERT_HAS_EXPIRED", "TLS_CERT_EXPIRED"], ["CERT_NOT_YET_VALID", "TLS_CERT_NOT_YET_VALID"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_HOSTNAME_MISMATCH"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "TLS_SELF_SIGNED"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "TLS_SELF_SIGNED"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "TLS_UNTRUSTED"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "TLS_UNTRUSTED"],
    ["ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "TLS_HANDSHAKE_FAILURE"],
    ["ERR_TLS_HANDSHAKE_TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"],
    ["ECONNREFUSED", "CONNECTION_FAILURE"], ["ECONNRESET", "CONNECTION_FAILURE"],
    ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"], ["ETIMEDOUT", "TIMEOUT"],
    ["ABORT_ERR", "ABORTED"],
  ])("recognizes only fixed error code %s", async (code, expected) => {
    const cause = new TypeError(privateText, { cause: { code, message: privateText } });
    expect(errorCode(cause)).toBe(expected);
    const error = await rejected(() => verifyHttps(origin, user, password, cookie,
      requester([{ error: cause }]).request));
    const output = [diagnosticLine(error, 1)];
    expect(output).toEqual([`KQ_PREVIEW_HTTPS stage=ANONYMOUS code=${expected} attempt=1`]);
    assertSafe(output);
  });

  test("accepts known exception names but never parses messages, stacks, or string causes", () => {
    expect(errorCode({ name: "TimeoutError", message: privateText })).toBe("TIMEOUT");
    expect(errorCode({ name: "AbortError", message: privateText })).toBe("ABORTED");
    for (const error of [
      privateText, { message: "ENOTFOUND", stack: "CERT_HAS_EXPIRED", cause: "ECONNRESET" },
      { name: privateText, code: privateText, cause: { message: privateText, cause: { name: privateText } } },
      { stage: privateText, code: "ENOTFOUND\nPRIVATE" },
    ]) {
      expect(errorCode(error)).toBe("UNKNOWN");
      assertSafe([diagnosticLine(error)]);
    }
    const cycle = { message: privateText };
    cycle.cause = cycle;
    expect(errorCode(cycle)).toBe("UNKNOWN");
    const getter = { get code() { throw new Error(privateText); } };
    expect(errorCode(getter)).toBe("UNKNOWN");
    const known = { code: "ENOTFOUND", get message() { throw new Error("must not read"); } };
    expect(errorCode(known)).toBe("DNS_NOT_FOUND");
  });
});

describe("HTTPS CLI retries", () => {
  test.each(["PREVIEW_USER", "PREVIEW_PASSWORD"])("missing %s never falls back to a default account or requests HTTPS", async (key) => {
    const data = JSON.parse(secret).data;
    delete data[key];
    const output = [];
    let calls = 0;
    const ready = await runCLI(["/private/secret"], env, {
      files: { readFileSync: () => JSON.stringify({ data }) },
      request: async () => { calls++; throw new Error("must not request"); },
      emit: (entry) => output.push(entry), sleep: async () => {},
    });
    expect(ready).toBe(false);
    expect(calls).toBe(0);
    expect(output[0]).toBe("KQ_PREVIEW_HTTPS stage=INPUT code=UNKNOWN attempt=1");
    assertSafe(output);
  });

  test("reports each successful check and a fixed completion marker without secrets", async () => {
    const output = [];
    const server = requester();
    const ready = await runCLI(["/private/secret"], env, {
      files: { readFileSync: () => secret }, request: server.request,
      emit: (entry) => output.push(entry),
      sleep: async () => { throw new Error("must not sleep after success"); },
    });
    expect(ready).toBe(true);
    expect(server.calls[2].options.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
    );
    expect(output.map((entry) => entry.split(" ")[1])).toEqual([
      "stage=ANONYMOUS", "stage=ANONYMOUS_LOCATION", "stage=CHALLENGE", "stage=UNLOCK",
      "stage=COOKIE", "stage=WEB", "stage=WEB_HTML", "stage=HEALTH", "stage=COMPLETE",
    ]);
    expect(output.at(-1)).toBe("KQ_PREVIEW_HTTPS stage=COMPLETE code=OK attempt=1");
    assertSafe(output);
  });

  test("retries a transient cause once, then restarts acceptance from the anonymous request", async () => {
    const output = [];
    const delays = [];
    const server = requester();
    let first = true;
    const ready = await runCLI(["/private/secret"], env, {
      files: { readFileSync: () => secret },
      request: (...args) => {
        if (first) {
          first = false;
          throw new TypeError(privateText, { cause: { code: "ECONNREFUSED" } });
        }
        return server.request(...args);
      },
      emit: (entry) => output.push(entry), sleep: async (milliseconds) => delays.push(milliseconds),
    });
    expect(ready).toBe(true);
    expect(delays).toEqual([5000]);
    expect(server.calls).toHaveLength(5);
    expect(output[0]).toBe("KQ_PREVIEW_HTTPS stage=ANONYMOUS code=CONNECTION_FAILURE attempt=1");
    expect(output.at(-1)).toBe("KQ_PREVIEW_HTTPS stage=COMPLETE code=OK attempt=2");
    assertSafe(output);
  });

  test("retains exactly twelve failures and twelve five-second delays before failing closed", async () => {
    const output = [];
    const delays = [];
    let calls = 0;
    const ready = await runCLI(["/private/secret"], env, {
      files: { readFileSync: () => secret },
      request: async () => { calls++; throw { cause: { code: privateText, message: privateText } }; },
      emit: (entry) => output.push(entry), sleep: async (milliseconds) => delays.push(milliseconds),
    });
    expect(ready).toBe(false);
    expect(calls).toBe(12);
    expect(delays).toEqual(Array(12).fill(5000));
    expect(output).toHaveLength(13);
    expect(output[11]).toBe("KQ_PREVIEW_HTTPS stage=ANONYMOUS code=UNKNOWN attempt=12");
    expect(output[12]).toBe("KQ_PREVIEW_HTTPS stage=COMPLETE code=RETRIES_EXHAUSTED attempt=12");
    assertSafe(output);
  });

  test.each(["invalid-pr", "invalid-json", "missing-file", "denied-file"])("input failure %s is fixed and does not request HTTPS", async (mode) => {
    const output = [];
    const ready = await runCLI(["/private/secret"], mode === "invalid-pr" ? { PREVIEW_PR: privateText } : env, {
      files: { readFileSync: () => {
        if (mode === "invalid-json") return privateText;
        throw Object.assign(new Error(privateText), { code: mode === "missing-file" ? "ENOENT" : "EACCES" });
      } },
      request: async () => { throw new Error("must not request"); },
      emit: (entry) => output.push(entry),
    });
    const expected = {
      "invalid-pr": "INVALID_PR", "invalid-json": "INVALID_JSON",
      "missing-file": "FILE_MISSING", "denied-file": "FILE_DENIED",
    };
    expect(ready).toBe(false);
    expect(output).toEqual([`KQ_PREVIEW_HTTPS stage=INPUT code=${expected[mode]}`]);
    assertSafe(output);
  });
});
