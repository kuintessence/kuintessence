import { createHash, randomBytes, sign, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:http2";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { recoverSlurmSpackInstallation } from "@kuintessence/agent/spack-recovery";
import { openSiteTls, readSiteTransport, siteFetch } from "@kuintessence/shared/site-transport";
import type { Command } from "commander";
import { z } from "zod";

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  });
const download = z
  .object({
    url: httpsUrl,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(8 * 1024 * 1024),
  })
  .strict();
const upload = z
  .object({ url: httpsUrl, body: z.string().max(8 * 1024 * 1024), verify: download })
  .strict();
export const doctorFixturesSchema = z
  .object({
    version: z.literal(1),
    material: download.optional(),
    objectGet: download.optional(),
    objectPut: upload.optional(),
    multipart: z
      .object({
        parts: z
          .array(z.object({ url: httpsUrl, body: z.string().max(8 * 1024 * 1024) }).strict())
          .min(2)
          .max(4),
        completeUrl: httpsUrl,
        abortUrl: httpsUrl,
        verify: download,
      })
      .strict()
      .optional(),
  })
  .strict();
type Fixtures = z.infer<typeof doctorFixturesSchema>;
export interface DoctorCheck {
  channel: string;
  status: "passed" | "failed" | "not-tested";
  detail: string;
}
export interface DoctorOptions {
  url: string;
  grpcUrl?: string;
  tokenFile?: string;
  fixtures?: string;
  certDir?: string;
  json?: boolean;
}

function api(base: string, path: string): string {
  httpsUrl.parse(base);
  if (new URL(base).search) throw new Error("Platform base URL cannot contain a query");
  return `${base.replace(/\/$/, "")}/api/${path}`;
}

class DoctorUnavailable extends Error {}

async function checkedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  httpsUrl.parse(url);
  const response = await siteFetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || response.status >= 300) {
    const error = new Error("request-failed") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

async function verifyDownload(fixture: z.infer<typeof download>): Promise<void> {
  const response = await checkedFetch(fixture.url);
  if (!response.body) throw new Error("missing-body");
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > fixture.size) throw new Error("unexpected-content");
      hash.update(value);
    }
  } finally {
    await reader.cancel();
  }
  if (size !== fixture.size || hash.digest("hex") !== fixture.sha256)
    throw new Error("unexpected-content");
}

/** Uses a separate diagnostic stream; never sends Agent Register or takes its live connection. */
export async function probeDuplex(base: string, certDir: string): Promise<void> {
  const url = new URL(httpsUrl.parse(base));
  const [cert, key, ca] = await Promise.all(
    ["client.crt", "client.key", "ca.crt"].map((name) => readFile(join(certDir, name), "utf8")),
  );
  const transport = readSiteTransport();
  const socket = transport
    ? await openSiteTls(url, transport, { cert, key, ca })
    : await new Promise<ReturnType<typeof tlsConnect>>((resolve, reject) => {
        const secure = tlsConnect({
          host: url.hostname,
          port: Number(url.port || 443),
          servername: url.hostname,
          cert,
          key,
          ca,
          rejectUnauthorized: true,
          ALPNProtocols: ["h2"],
        });
        const timer = setTimeout(() => secure.destroy(new Error("timeout")), 15_000);
        secure.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        secure.once("secureConnect", () => {
          clearTimeout(timer);
          if (secure.alpnProtocol !== "h2") {
            secure.destroy();
            reject(new Error("http2-required"));
          } else resolve(secure);
        });
      });
  const session = connect(url.origin, { createConnection: () => socket });
  await new Promise<void>((resolve, reject) => {
    const request = session.request({
      ":method": "POST",
      ":path": "/site-diagnostics/stream",
      "content-type": "application/x-ndjson",
    });
    const challenges = [randomBytes(24).toString("hex"), randomBytes(24).toString("hex")];
    let round = 0;
    let pending = "";
    let accepted = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.close();
      session.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("timeout")), 20_000);
    session.once("error", () => finish(new Error("http2-failed")));
    request.once("error", () => finish(new Error("stream-failed")));
    request.on("response", (headers) => {
      accepted = headers[":status"] === 200;
      if (!accepted) finish(new Error("stream-rejected"));
    });
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 4096) return finish(new Error("invalid-response"));
      while (pending.includes("\n")) {
        const newline = pending.indexOf("\n");
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return finish(new Error("invalid-response"));
        }
        if (
          !accepted ||
          !message ||
          typeof message !== "object" ||
          !("challenge" in message) ||
          message.challenge !== challenges[round] ||
          !("seq" in message) ||
          message.seq !== round ||
          !("agentId" in message) ||
          typeof message.agentId !== "string" ||
          !message.agentId
        )
          return finish(new Error("challenge-mismatch"));
        round++;
        if (round === 2) {
          request.end();
          return finish();
        }
        request.write(`${JSON.stringify({ challenge: challenges[round], seq: round })}\n`);
      }
    });
    request.once("end", () => {
      if (round !== 2) finish(new Error("stream-ended"));
    });
    request.write(`${JSON.stringify({ challenge: challenges[0], seq: 0 })}\n`);
  });
}

async function createFixtures(
  options: DoctorOptions,
): Promise<{ fixtures: Fixtures; cleanupUrl: string }> {
  const certDir = options.certDir as string;
  const [certificate, key, env] = await Promise.all([
    readFile(join(certDir, "client.crt"), "utf8"),
    readFile(join(certDir, "client.key"), "utf8"),
    readFile(join(certDir, "..", "agent.env"), "utf8"),
  ]);
  const match = env.match(/^AGENT_ID=("(?:[^"\\]|\\.)*")$/m);
  const agentId: unknown = match ? JSON.parse(match[1] as string) : undefined;
  if (typeof agentId !== "string" || !agentId) throw new Error("invalid-identity");
  new X509Certificate(certificate);
  const timestamp = Date.now();
  const nonce = randomBytes(24).toString("hex");
  const signature = sign(
    "sha256",
    Buffer.from(`kq-site-diagnostics-v1\n${agentId}\n${timestamp}\n${nonce}`),
    key,
  ).toString("base64");
  const response = await checkedFetch(api(options.url, "agent/site-diagnostics"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId, certificate, timestamp, nonce, signature }),
  }).catch((error: unknown) => {
    if (error instanceof Error && "status" in error && error.status === 404)
      throw new DoctorUnavailable();
    throw error;
  });
  const raw = await response.json();
  const resolved: unknown = JSON.parse(JSON.stringify(raw), (key, value: unknown) => {
    if (["url", "completeUrl", "abortUrl", "cleanupUrl"].includes(key) && typeof value === "string")
      return new URL(value, api(options.url, "")).href;
    return value;
  });
  const result = z
    .object({
      version: z.literal(1),
      identity: z.object({ agentId: z.literal(agentId) }),
      fixtures: doctorFixturesSchema,
      cleanupUrl: httpsUrl,
    })
    .parse(resolved);
  return result;
}

export async function runSiteDoctor(
  options: DoctorOptions,
): Promise<{ version: 1; checks: DoctorCheck[]; complete: boolean }> {
  const checks: DoctorCheck[] = [];
  const check = async (channel: string, enabled: boolean, test: () => Promise<void>) => {
    if (!enabled) {
      checks.push({ channel, status: "not-tested", detail: "missing-credentials-or-fixture" });
      return;
    }
    try {
      await test();
      checks.push({
        channel,
        status: "passed",
        detail: channel === "material-get" ? "probe-only-not-spack-closure" : "verified",
      });
    } catch (error) {
      checks.push(
        error instanceof DoctorUnavailable
          ? { channel, status: "not-tested", detail: "diagnostic-endpoint-unavailable" }
          : { channel, status: "failed", detail: "request-or-verification-failed" },
      );
    }
  };
  let fixtures: Fixtures = { version: 1 };
  if (options.fixtures)
    fixtures = doctorFixturesSchema.parse(JSON.parse(await readFile(options.fixtures, "utf8")));
  let cleanupUrl: string | undefined;
  let token: string | undefined;
  if (options.tokenFile) {
    token = (
      options.tokenFile === "-" ? await Bun.stdin.text() : await readFile(options.tokenFile, "utf8")
    ).trim();
    if (!token || token.length > 16384) throw new Error("Invalid token file");
  }
  await check("https", true, async () => {
    const result = await checkedFetch(api(options.url, "agent-binaries"));
    const body: unknown = await result.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("revision" in body) ||
      typeof body.revision !== "string"
    )
      throw new Error("invalid-response");
  });
  await check("registration-identity", !!token || !!options.certDir, async () => {
    if (options.certDir) {
      const issued = await createFixtures(options);
      if (!options.fixtures) fixtures = issued.fixtures;
      cleanupUrl = issued.cleanupUrl;
      return;
    }
    const response = await checkedFetch(api(options.url, "agent-registration/metadata"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("agentId" in body) ||
      typeof body.agentId !== "string" ||
      !body.agentId
    )
      throw new Error("invalid-identity");
  });
  await check("mtls-http2-duplex", !!options.grpcUrl && !!options.certDir, async () => {
    await probeDuplex(options.grpcUrl as string, options.certDir as string);
  });
  await check("material-get", !!fixtures.material, async () => {
    await verifyDownload(fixtures.material as z.infer<typeof download>);
  });
  await check("object-get", !!fixtures.objectGet, async () => {
    await verifyDownload(fixtures.objectGet as z.infer<typeof download>);
  });
  await check("object-put", !!fixtures.objectPut, async () => {
    const fixture = fixtures.objectPut as z.infer<typeof upload>;
    await checkedFetch(fixture.url, { method: "PUT", body: fixture.body });
    await verifyDownload(fixture.verify);
  });
  await check("object-multipart", !!fixtures.multipart, async () => {
    const fixture = fixtures.multipart;
    if (!fixture) return;
    let completed = false;
    try {
      const parts: { PartNumber: number; ETag: string }[] = [];
      for (const [index, part] of fixture.parts.entries()) {
        const response = await checkedFetch(part.url, { method: "PUT", body: part.body });
        const etag = response.headers.get("etag");
        if (!etag || /[<>&]/.test(etag)) throw new Error("missing-etag");
        parts.push({ PartNumber: index + 1, ETag: etag });
      }
      const response = await checkedFetch(fixture.completeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          parts.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag })),
        ),
      });
      if ((await response.text()).includes("<Error>")) throw new Error("complete-failed");
      completed = true;
      await verifyDownload(fixture.verify);
    } finally {
      if (!completed && !cleanupUrl)
        await checkedFetch(fixture.abortUrl, { method: "DELETE" }).catch(() => {});
    }
  });
  if (cleanupUrl) {
    const url = cleanupUrl;
    await check("fixture-cleanup", true, async () => {
      await checkedFetch(url, { method: "DELETE" });
    });
  }
  return { version: 1, checks, complete: checks.every((result) => result.status === "passed") };
}

export function registerSiteCommand(program: Command): void {
  const site = program.command("site").description("Site connectivity diagnostics");
  site
    .command("recover-spack")
    .description("Reconcile a stopped Slurm Spack worker before a new install")
    .requiredOption("--store-root <path>", "Shared Spack store root")
    .requiredOption("--cache-dir <path>", "Shared material cache")
    .requiredOption("--record-id <id>", "Installation record id")
    .requiredOption("--operation-id <id>", "Original software operation id")
    .option("--slurm-bin-dir <path>", "Local Slurm executable directory")
    .action(
      async (options: {
        storeRoot: string;
        cacheDir: string;
        recordId: string;
        operationId: string;
        slurmBinDir?: string;
      }) => {
        await recoverSlurmSpackInstallation({ ...options, binDir: options.slurmBinDir });
        console.log("旧安装已标记 failed，仍不 ready；正常重试 install 将重新 build 和 verify。");
      },
    );
  site
    .command("doctor")
    .requiredOption("--url <url>", "Platform HTTPS base URL")
    .option("--grpc-url <url>", "Separate Agent mTLS HTTP/2 origin")
    .option("--token-file <path>", "Registration token file, or - for stdin (metadata only)")
    .option(
      "--cert-dir <path>",
      "Existing registration certificate directory; does not replace the Agent stream",
    )
    .option("--fixtures <path>", "Private platform-issued diagnostic fixture JSON")
    .option("--json", "Print a safe JSON report")
    .action(async (options: DoctorOptions) => {
      try {
        const report = await runSiteDoctor(options);
        console.log(
          options.json
            ? JSON.stringify(report, null, 2)
            : report.checks
                .map((result) => `${result.channel}: ${result.status} (${result.detail})`)
                .join("\n"),
        );
        if (!report.complete) process.exitCode = 1;
      } catch {
        throw new Error(
          "Site diagnostic configuration invalid; check private input files and HTTPS configuration",
        );
      }
    });
}
