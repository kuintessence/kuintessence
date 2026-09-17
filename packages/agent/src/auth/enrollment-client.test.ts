import { describe, expect, test } from "bun:test";
import { createHttpEnrollmentClient } from "./enrollment-client";

describe("createHttpEnrollmentClient", () => {
  function fakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
    return ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input.toString(), init);
      return Promise.resolve(handler(req));
    }) as typeof fetch;
  }

  test("POSTs CSR with enrollment token and parses cert envelope", async () => {
    const client = createHttpEnrollmentClient({
      serverBaseUrl: "https://server.example/api",
      fetchImpl: fakeFetch(async (req) => {
        expect(req.method).toBe("POST");
        const url = new URL(req.url);
        expect(url.pathname).toBe("/api/admin/agents/agent-q/cert");
        expect(req.headers.get("Authorization")).toBe("Bearer enroll-token-x");
        const body = (await req.json()) as { csrPem: string };
        expect(body.csrPem).toBe("CSRBODY");
        return Response.json(
          {
            success: true,
            certPem: "ISSUED",
            caCertPem: "CABUNDLE",
            fingerprintSha256: "0".repeat(64),
            issuedAt: new Date().toISOString(),
            expiresAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    });

    const result = await client({
      agentId: "agent-q",
      csrPem: "CSRBODY",
      enrollmentToken: "enroll-token-x",
    });
    expect(result.certPem).toBe("ISSUED");
    expect(result.caCertPem).toBe("CABUNDLE");
  });

  test("throws on non-2xx response with the Server error message", async () => {
    const client = createHttpEnrollmentClient({
      serverBaseUrl: "https://server.example/api",
      fetchImpl: fakeFetch(async () =>
        Response.json(
          { error: { code: "FORBIDDEN", message: "Need platform_admin" } },
          { status: 403 },
        ),
      ),
    });

    await expect(client({ agentId: "x", csrPem: "y", enrollmentToken: "z" })).rejects.toThrow(
      /403|platform_admin|enroll/i,
    );
  });

  test("throws on malformed JSON response", async () => {
    const client = createHttpEnrollmentClient({
      serverBaseUrl: "https://server.example/api",
      fetchImpl: fakeFetch(
        async () =>
          new Response("not json", { status: 201, headers: { "content-type": "text/plain" } }),
      ),
    });
    await expect(client({ agentId: "x", csrPem: "y", enrollmentToken: "z" })).rejects.toThrow();
  });

  test("trims trailing slash in serverBaseUrl", async () => {
    let capturedPath = "";
    const client = createHttpEnrollmentClient({
      serverBaseUrl: "https://server.example/api/",
      fetchImpl: fakeFetch(async (req) => {
        capturedPath = new URL(req.url).pathname;
        return Response.json({ success: true, certPem: "C", caCertPem: "CA" }, { status: 201 });
      }),
    });
    await client({ agentId: "a", csrPem: "b", enrollmentToken: "c" });
    expect(capturedPath).toBe("/api/admin/agents/a/cert");
  });
});
