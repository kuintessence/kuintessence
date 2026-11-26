import { createPrivateKey, X509Certificate } from "node:crypto";
import * as asn1 from "asn1js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  BasicOCSPResponse,
  CertID,
  Certificate,
  CertificateRevocationList,
  id_PKIX_OCSP_Basic,
  OCSPRequest,
  OCSPResponse,
  ResponseBytes,
  RevokedCertificate,
  SingleResponse,
  Time,
} from "pkijs";
import type { CaMaterial } from "../auth/ca";

const MAX_REQUEST = 4096;
const NONCE = "1.3.6.1.5.5.7.48.1.2";
const hashes = new Map([
  ["1.3.14.3.2.26", "SHA-1"],
  ["2.16.840.1.101.3.4.2.1", "SHA-256"],
]);
type LedgerRow = { certPem: string; revokedAt: Date | null };
type Ledger = () => Promise<LedgerRow[]>;

function response(status: number, responseBytes?: ResponseBytes) {
  const result = new OCSPResponse({
    responseStatus: new asn1.Enumerated({ value: status }),
    ...(responseBytes ? { responseBytes } : {}),
  });
  return new Response(result.toSchema().toBER(false), {
    headers: {
      "Content-Type": "application/ocsp-response",
      "Cache-Control": "no-store",
    },
  });
}

export function createAgentPkiRoutes(ca: CaMaterial, loadUnexpired: Ledger) {
  const app = new Hono();
  const signingCa = new X509Certificate(ca.certPem);
  const issuer = Certificate.fromBER(signingCa.raw);
  const key = crypto.subtle.importKey(
    "pkcs8",
    createPrivateKey(ca.keyPem).export({ format: "der", type: "pkcs8" }),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const issuerIDs = new Map(
    [...hashes].map(([oid, hashAlgorithm]) => [
      oid,
      CertID.create(issuer, { issuerCertificate: issuer, hashAlgorithm }),
    ]),
  );
  async function loadSnapshot(now: Date) {
    const serials = new Map<string, Date | null>();
    const revokedCertificates: RevokedCertificate[] = [];
    for (const row of await loadUnexpired()) {
      const cert = new X509Certificate(row.certPem);
      if (!cert.checkIssued(signingCa) || !cert.verify(signingCa.publicKey)) continue;
      const serial = Certificate.fromBER(cert.raw).serialNumber;
      serials.set(serial.toBigInt().toString(), row.revokedAt);
      if (row.revokedAt)
        revokedCertificates.push(
          new RevokedCertificate({
            userCertificate: serial,
            revocationDate: new Time({ value: row.revokedAt }),
          }),
        );
    }
    const next = new Date(now.getTime() + 60_000);
    const crl = new CertificateRevocationList({
      issuer: issuer.subject,
      thisUpdate: new Time({ value: now }),
      nextUpdate: new Time({ value: next }),
      ...(revokedCertificates.length ? { revokedCertificates } : {}),
    });
    await crl.sign(await key, "SHA-256");
    return { now, next, serials, crl: crl.toSchema().toBER(false) };
  }
  let cached: ReturnType<typeof loadSnapshot> | undefined;
  let expires = 0;
  function snapshot() {
    const now = Date.now();
    if (!cached || now >= expires) {
      expires = now + 30_000;
      const pending = loadSnapshot(new Date(now));
      cached = pending;
      pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
    }
    return cached;
  }
  app.get(
    "/crl",
    async () =>
      new Response((await snapshot()).crl, {
        headers: {
          "Content-Type": "application/pkix-crl",
          "Cache-Control": "no-cache",
        },
      }),
  );
  async function answer(bytes: Uint8Array) {
    let request: OCSPRequest;
    try {
      const { offset, result } = asn1.fromBER(bytes);
      if (offset !== bytes.length || !bytes.length) return response(1);
      request = new OCSPRequest({ schema: result });
    } catch {
      return response(1);
    }
    const { requestList, requestExtensions = [] } = request.tbsRequest;
    if (
      !requestList.length ||
      requestList.length > 8 ||
      requestList.some((r) => r.singleRequestExtensions?.some((e) => e.critical)) ||
      requestExtensions.some((e) => e.critical && e.extnID !== NONCE)
    )
      return response(1);
    const nonces = requestExtensions.filter((e) => e.extnID === NONCE);
    if (
      nonces.length > 1 ||
      nonces.some((e) => {
        const raw = e.extnValue.valueBlock.valueHexView;
        const nonce = asn1.fromBER(raw);
        return (
          nonce.offset !== raw.length ||
          !(nonce.result instanceof asn1.OctetString) ||
          nonce.result.valueBlock.valueHexView.length < 1 ||
          nonce.result.valueBlock.valueHexView.length > 32
        );
      })
    )
      return response(1);
    for (const { reqCert } of requestList) {
      const expected = await issuerIDs.get(reqCert.hashAlgorithm.algorithmId);
      if (
        !expected ||
        !reqCert.issuerNameHash.isEqual(expected.issuerNameHash) ||
        !reqCert.issuerKeyHash.isEqual(expected.issuerKeyHash)
      )
        return response(6);
    }
    const { now, next, serials } = await snapshot();
    const basic = new BasicOCSPResponse({ certs: [issuer] });
    basic.tbsResponseData.responderID = issuer.subject;
    basic.tbsResponseData.producedAt = new Date();
    if (nonces.length) basic.tbsResponseData.responseExtensions = nonces;
    basic.tbsResponseData.responses = requestList.map(({ reqCert }) => {
      const revoked = serials.get(reqCert.serialNumber.toBigInt().toString());
      const certStatus = revoked
        ? new asn1.Constructed({
            idBlock: { tagClass: 3, tagNumber: 1 },
            value: [new asn1.GeneralizedTime({ valueDate: revoked })],
          })
        : new asn1.Primitive({ idBlock: { tagClass: 3, tagNumber: revoked === null ? 0 : 2 } });
      return new SingleResponse({ certID: reqCert, certStatus, thisUpdate: now, nextUpdate: next });
    });
    await basic.sign(await key, "SHA-256");
    return response(
      0,
      new ResponseBytes({
        responseType: id_PKIX_OCSP_Basic,
        response: new asn1.OctetString({ valueHex: basic.toSchema().toBER(false) }),
      }),
    );
  }
  app.post("/ocsp", bodyLimit({ maxSize: MAX_REQUEST }), async (c) =>
    c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() === "application/ocsp-request"
      ? answer(new Uint8Array(await c.req.arrayBuffer()))
      : c.body(null, 415),
  );
  app.get("/ocsp/:encoded{.+}", (c) => {
    const encoded = c.req.param("encoded");
    if (encoded.length > Math.ceil(MAX_REQUEST / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      return response(1);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_REQUEST || bytes.toString("base64") !== encoded) return response(1);
    return answer(bytes);
  });
  return app;
}
