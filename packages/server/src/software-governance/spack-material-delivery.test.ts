import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AppError, type SpackMaterialManifest } from "@kuintessence/shared";
import { Hono } from "hono";
import { decodeJwt, SignJWT } from "jose";
import { createAgentSpackMaterialRoutes } from "../routes/agent-spack-materials";
import {
  SpackMaterialDelivery,
  type SpackMaterialReferencePort,
  type SpackOperationAccess,
} from "./spack-material-delivery";

const operationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const hash = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const blobBytes = Buffer.from("fixture source");
const blob = { digest: hash(blobBytes), size: blobBytes.length };
const ticketKey = "ticket-only-secret".repeat(3);
const registryKey = "registry-secret".repeat(3);

function fixture(repository = "org/provider-a/sources", downloadLifetimeMs?: number) {
  const manifest: SpackMaterialManifest = {
    version: 1,
    repository,
    spec: "zlib@1.3.1",
    spackVersion: "1.0.0",
    target: "linux-x86_64",
    redistribution: "unrestricted",
    recipes: [
      {
        repositoryId: "a".repeat(64),
        commit: "b".repeat(40),
        roots: ["."],
        archive: blob,
      },
    ],
    sources: [{ path: "zlib/zlib-1.3.1.tar.gz", blob }],
    lockfile: blob,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const binding = {
    repositoryId: createHash("sha256").update(repository).digest("hex"),
    manifestDigest: hash(bytes),
  };
  let access: SpackOperationAccess | null = {
    agentId: "agent-a",
    requestedBy: userId,
    providerOrgId: "provider-a",
    spec: manifest.spec,
  };
  let certificateValid = true;
  let manifestBody: Uint8Array = bytes;
  let blobBody: Uint8Array = blobBytes;
  let upstreamStatus = 200;
  let stallCancellation = false;
  let referenceFailure = false;
  let registrationFailure = false;
  const referenceEvents: string[] = [];
  const registeredBindings: Parameters<SpackMaterialReferencePort["registerBindings"]>[0][] = [];
  const operationReferences: Parameters<SpackMaterialReferencePort["acquireOperation"]>[0][] = [];
  const references: SpackMaterialReferencePort = {
    async registerBindings(bindings) {
      referenceEvents.push("register");
      if (registrationFailure) throw new Error("private database connection details");
      registeredBindings.push(structuredClone(bindings));
    },
    async acquireOperation(input) {
      referenceEvents.push("acquire");
      if (referenceFailure) throw new Error("private database connection details");
      operationReferences.push(input);
    },
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const channel = {
    push() {},
    close() {},
    spackMaterialDeliveryV1: true,
    verifiedCertFingerprint: "c".repeat(64),
  };
  const bindings = { [manifest.spec]: binding };
  const delivery = new SpackMaterialDelivery({
    registryUrl: "https://registry.internal",
    registryJwtSecret: registryKey,
    ticketSecret: ticketKey,
    downloadLifetimeMs,
    bindings,
    references,
    access: {
      operation: async () => access,
      certificate: async () => certificateValid,
    },
    dispatcher: { getChannel: () => channel },
    fetch: Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        referenceEvents.push("fetch");
        calls.push({ url: String(url), init });
        return new Response(
          stallCancellation
            ? new ReadableStream({
                cancel: () => new Promise<void>(() => {}),
              })
            : String(url).includes("/blobs/")
              ? blobBody
              : manifestBody,
          {
            status: upstreamStatus,
          },
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(error.toJSON(), error.statusCode as 400 | 401 | 403 | 404 | 429 | 502 | 503);
    }
    return c.json({ error: "internal" }, 500);
  });
  app.route("/api", createAgentSpackMaterialRoutes(delivery));
  const prepare = () =>
    delivery.prepareOperation({
      operationId,
      agentId: "agent-a",
      requestedBy: userId,
      spec: manifest.spec,
    });
  return {
    delivery,
    app,
    prepare,
    calls,
    bytes,
    binding,
    channel,
    bindings,
    referenceEvents,
    registeredBindings,
    operationReferences,
    setReferenceFailure(value: boolean) {
      referenceFailure = value;
    },
    setRegistrationFailure(value: boolean) {
      registrationFailure = value;
    },
    setAccess(value: SpackOperationAccess | null) {
      access = value;
    },
    setCertificate(value: boolean) {
      certificateValid = value;
    },
    setManifest(value: Uint8Array) {
      manifestBody = value;
    },
    setBlob(value: Uint8Array) {
      blobBody = value;
    },
    setUpstreamStatus(value: number) {
      upstreamStatus = value;
    },
    stallCancellation() {
      stallCancellation = true;
    },
  };
}

describe("Server Spack material delivery", () => {
  test("registers configuration before delivery and pins the operation before issuing a ticket", async () => {
    const f = fixture();
    await f.delivery.initialize();
    expect(f.referenceEvents).toEqual(["register"]);
    expect(f.registeredBindings).toEqual([{ "zlib@1.3.1": f.binding }]);
    await f.prepare();
    expect(f.referenceEvents).toEqual(["register", "fetch", "acquire"]);
    expect(f.operationReferences).toEqual([
      {
        ...f.binding,
        operationId,
        agentId: "agent-a",
        requestedBy: userId,
        spec: "zlib@1.3.1",
      },
    ]);
  });

  test("concurrent initialization shares one configuration registration", async () => {
    const f = fixture();
    await Promise.all([f.delivery.initialize(), f.delivery.initialize()]);
    expect(f.registeredBindings).toHaveLength(1);
  });

  test("failed configuration registration denies preparation without exposing database details", async () => {
    const f = fixture();
    f.setRegistrationFailure(true);
    await expect(f.prepare()).rejects.toThrow("reference registry is unavailable");
    expect(f.calls).toHaveLength(0);
    expect(f.operationReferences).toHaveLength(0);
    f.setRegistrationFailure(false);
    expect((await f.prepare()).spackMaterialTicket).toBeTruthy();
  });

  test("a failed operation reference prevents ticket issue and download", async () => {
    const f = fixture();
    f.setReferenceFailure(true);
    await expect(f.prepare()).rejects.toThrow("reference registry is unavailable");
    f.setReferenceFailure(false);
    const ticket = await f.prepare();
    f.setReferenceFailure(true);
    const callsBeforeDownload = f.calls.length;
    await expect(f.delivery.download(operationId, ticket.spackMaterialTicket)).rejects.toThrow(
      "reference registry is unavailable",
    );
    expect(f.calls).toHaveLength(callsBeforeDownload);
    const response = await f.app.request(`/api/agent/spack/operations/${operationId}/manifest`, {
      headers: { Authorization: `Bearer ${ticket.spackMaterialTicket}` },
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("reference registry is unavailable");
    expect(body).not.toContain("private database");
  });

  test("download retains the ticket binding in its durable reference after configuration changes", async () => {
    const f = fixture();
    const ticket = await f.prepare();
    f.bindings["zlib@1.3.1"] = { ...f.binding, manifestDigest: hash("replacement") };
    await f.delivery.download(operationId, ticket.spackMaterialTicket);
    expect(f.operationReferences.at(-1)?.manifestDigest).toBe(f.binding.manifestDigest);
    expect(f.referenceEvents.slice(-2)).toEqual(["acquire", "fetch"]);
  });

  test("pins exact manifest and keeps Registry credentials and URLs behind Server", async () => {
    const f = fixture();
    const ticket = await f.prepare();
    expect(ticket.spackManifestDigest).toBe(hash(f.bytes));
    const token = decodeJwt(ticket.spackMaterialTicket);
    expect(token.iss).toBe("kq-spack-delivery");
    expect(token.aud).toBe("kq-agent-spack");
    expect(JSON.stringify(token)).not.toContain("registry.internal");
    expect(JSON.stringify(token)).not.toContain(registryKey);
    const response = await f.app.request(`/api/agent/spack/operations/${operationId}/manifest`, {
      headers: { Authorization: `Bearer ${ticket.spackMaterialTicket}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toBe(f.bytes.toString());
    expect(f.calls.every((call) => call.init?.redirect === "error")).toBe(true);
    const registryAuthorization = new Headers(f.calls[0]?.init?.headers).get("Authorization");
    expect(registryAuthorization).not.toBe(`Bearer ${ticket.spackMaterialTicket}`);
    expect(decodeJwt(registryAuthorization?.slice(7) ?? "").sub).toBe(userId);
  });

  test("serves only listed blobs and validates checksum", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    const response = await f.delivery.download(operationId, spackMaterialTicket, blob.digest);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(blobBytes);
    await expect(
      f.delivery.download(operationId, spackMaterialTicket, hash("other")),
    ).rejects.toThrow("not part");
    f.setBlob(Buffer.from("tampered"));
    const corrupt = await f.delivery.download(operationId, spackMaterialTicket, blob.digest);
    await expect(corrupt.arrayBuffer()).rejects.toThrow();
  });

  test("rejects absent capability, non-mTLS channel, and revoked certificate", async () => {
    const f = fixture();
    f.channel.spackMaterialDeliveryV1 = false;
    await expect(f.prepare()).rejects.toThrow("verified mTLS");
    f.channel.spackMaterialDeliveryV1 = true;
    f.channel.verifiedCertFingerprint = "";
    await expect(f.prepare()).rejects.toThrow("verified mTLS");
    f.channel.verifiedCertFingerprint = "c".repeat(64);
    f.setCertificate(false);
    await expect(f.prepare()).rejects.toThrow("authorization");
    expect(f.calls).toHaveLength(0);
  });

  test("refuses cross-provider and personal releases even for a Registry-authorized user", async () => {
    await expect(fixture("org/provider-b/sources").prepare()).rejects.toThrow("provider scope");
    await expect(fixture(`user/${userId}/sources`).prepare()).rejects.toThrow("provider scope");
    expect((await fixture("public/sources").prepare()).spackMaterialTicket).toBeTruthy();
  });

  test("rechecks operation state, provider membership and certificate on each download", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    f.setCertificate(false);
    await expect(f.delivery.download(operationId, spackMaterialTicket)).rejects.toThrow(
      "authorization",
    );
    f.setCertificate(true);
    f.setAccess({
      agentId: "agent-a",
      requestedBy: userId,
      providerOrgId: "provider-b",
      spec: "zlib@1.3.1",
    });
    await expect(f.delivery.download(operationId, spackMaterialTicket)).rejects.toThrow(
      "authorization",
    );
    f.setAccess(null);
    await expect(f.delivery.download(operationId, spackMaterialTicket)).rejects.toThrow(
      "authorization",
    );
  });

  test("ticket remains pinned when configured binding changes", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    f.bindings["zlib@1.3.1"] = { ...f.binding, manifestDigest: hash("new") };
    expect(await (await f.delivery.download(operationId, spackMaterialTicket)).text()).toBe(
      f.bytes.toString(),
    );
    expect(f.calls.at(-1)?.url).toContain(f.binding.manifestDigest);
  });

  test("rejects expired, forged, wrong-audience, or wrong-operation credentials", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    await expect(f.delivery.download(crypto.randomUUID(), spackMaterialTicket)).rejects.toThrow(
      "ticket",
    );
    await expect(f.delivery.download(operationId, `${spackMaterialTicket}x`)).rejects.toThrow(
      "ticket",
    );
    const payload = decodeJwt(spackMaterialTicket);
    for (const data of [
      { ...payload, exp: 1 },
      { ...payload, aud: "browser" },
      { ...payload, sub: "other-agent" },
    ]) {
      const token = await new SignJWT(data)
        .setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode(ticketKey));
      await expect(f.delivery.download(operationId, token)).rejects.toThrow("ticket");
    }
  });

  test("rejects unknown spec, corrupt manifests and all upstream redirect/error responses", async () => {
    const f = fixture();
    delete f.bindings["zlib@1.3.1"];
    await expect(f.prepare()).rejects.toThrow("No pinned");
    const bad = fixture();
    bad.setManifest(Buffer.from("{}"));
    await expect(bad.prepare()).rejects.toThrow("unavailable or invalid");
    for (const status of [302, 401, 404, 500]) {
      const redirect = fixture();
      redirect.setUpstreamStatus(status);
      await expect(redirect.prepare()).rejects.toThrow("unavailable or invalid");
    }
  });

  test("rejects query credentials/URLs and unsupported Range", async () => {
    const f = fixture();
    const ticket = await f.prepare();
    const path = `/api/agent/spack/operations/${operationId}/manifest`;
    const headers = { Authorization: `Bearer ${ticket.spackMaterialTicket}` };
    expect((await f.app.request(path)).status).toBe(401);
    expect((await f.app.request(`${path}?url=https://external.invalid`, { headers })).status).toBe(
      400,
    );
    expect(
      (await f.app.request(path, { headers: { ...headers, Range: "bytes=0-1" } })).status,
    ).toBe(400);
  });

  test("caps concurrent streams and releases capacity on cancellation", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    const responses: Response[] = [];
    for (let i = 0; i < 8; i++) {
      responses.push(await f.delivery.download(operationId, spackMaterialTicket, blob.digest));
    }
    await expect(
      f.delivery.download(operationId, spackMaterialTicket, blob.digest),
    ).rejects.toThrow("busy");
    for (const response of responses) await response.body?.cancel();
    expect(await (await f.delivery.download(operationId, spackMaterialTicket)).text()).toBeTruthy();
  });

  test("expires abandoned streams even when the consumer never reads them", async () => {
    const f = fixture("public/sources", 20);
    const { spackMaterialTicket } = await f.prepare();
    const response = await f.delivery.download(operationId, spackMaterialTicket, blob.digest);
    await Bun.sleep(40);
    await expect((async () => response.arrayBuffer())()).rejects.toThrow();
    expect((await f.delivery.download(operationId, spackMaterialTicket)).status).toBe(200);
  });

  test("an error response with a stalled cancel hook cannot retain download slots", async () => {
    const f = fixture();
    const { spackMaterialTicket } = await f.prepare();
    f.stallCancellation();
    f.setUpstreamStatus(503);
    for (let i = 0; i < 10; i++) {
      await expect(f.delivery.download(operationId, spackMaterialTicket)).rejects.toThrow(
        "unavailable",
      );
    }
  }, 1000);
});
