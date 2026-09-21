import { expect, mock, test } from "bun:test";
import { createRegistryHttpHandler, REGISTRY_LEGACY_BODY_BYTES } from "./registry-http";
import { MATERIAL_MAX_BLOB_BYTES } from "./services/spack-material-storage";

const UPLOAD = "/api/spack/material-repositories/blobs";

test("only an enabled material store raises the bounded Bun listener ceiling", () => {
  const handle = () => new Response("ok");
  expect(createRegistryHttpHandler(handle).maxRequestBodySize).toBe(REGISTRY_LEGACY_BODY_BYTES);
  expect(createRegistryHttpHandler(handle, 1024).maxRequestBodySize).toBe(
    REGISTRY_LEGACY_BODY_BYTES,
  );
  expect(createRegistryHttpHandler(handle, MATERIAL_MAX_BLOB_BYTES).maxRequestBodySize).toBe(
    MATERIAL_MAX_BLOB_BYTES,
  );
});

test.each([
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  MATERIAL_MAX_BLOB_BYTES + 1,
])("rejects an invalid material transport budget: %s", (limit) => {
  expect(() => createRegistryHttpHandler(() => new Response(), limit)).toThrow(
    "Invalid Registry material HTTP body limit",
  );
});

test("passes exact raw material uploads unchanged to the existing route checks", async () => {
  const response = new Response("existing authorization result", { status: 403 });
  const handle = mock(() => response);
  const request = new Request(`http://localhost${UPLOAD}?repository=public/test`, {
    method: "POST",
    headers: {
      "Content-Type": "Application/Octet-Stream; charset=binary",
      "Content-Length": String(REGISTRY_LEGACY_BODY_BYTES + 1),
    },
    body: new Uint8Array([1]),
  });
  const http = createRegistryHttpHandler(handle, MATERIAL_MAX_BLOB_BYTES);
  expect(await http.fetch(request)).toBe(response);
  expect(handle).toHaveBeenCalledWith(request);
  await request.body?.cancel();
});

test.each([
  { path: "/api/ordinary-json", method: "POST", type: "application/json" },
  { path: "/v2/public/test/blobs/uploads/id", method: "PATCH", type: "application/octet-stream" },
  { path: "/buildcache/test", method: "PUT", type: "application/octet-stream" },
  { path: `${UPLOAD}-other`, method: "POST", type: "application/octet-stream" },
  { path: `${UPLOAD}/`, method: "POST", type: "application/octet-stream" },
  { path: UPLOAD, method: "PUT", type: "application/octet-stream" },
  { path: UPLOAD, method: "POST", type: "application/json" },
])("keeps legacy limits for $method $path ($type)", async ({ path, method, type }) => {
  const handle = mock(() => new Response("must not reach the handler"));
  const http = createRegistryHttpHandler(handle, MATERIAL_MAX_BLOB_BYTES);
  const response = await http.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": type,
        "Content-Length": String(REGISTRY_LEGACY_BODY_BYTES + 1),
      },
      body: new Uint8Array([1]),
    }),
  );
  expect(response.status).toBe(413);
  expect(response.headers.get("Connection")).toBe("close");
  expect(handle).not.toHaveBeenCalled();
});

test("a disabled material store cannot opt out of the original body limit", async () => {
  const handle = mock(() => new Response());
  const response = await createRegistryHttpHandler(handle).fetch(
    new Request(`http://localhost${UPLOAD}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(REGISTRY_LEGACY_BODY_BYTES + 1),
      },
      body: new Uint8Array([1]),
    }),
  );
  expect(response.status).toBe(413);
  expect(response.headers.get("Connection")).toBe("close");
  expect(handle).not.toHaveBeenCalled();
});

test.each([
  false,
  true,
])("bounds actual legacy bytes with a forged small length=%s", async (forged) => {
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const size = Math.min(chunk.length, REGISTRY_LEGACY_BODY_BYTES + 1 - sent);
      if (!size) controller.close();
      else {
        sent += size;
        controller.enqueue(chunk.subarray(0, size));
      }
    },
  });
  const http = createRegistryHttpHandler(async (request) => {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing request body");
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) return new Response("unexpected success");
        received += item.value.byteLength;
      }
    } catch {
      return new Response("parser translated the error", { status: 400 });
    } finally {
      reader.releaseLock();
    }
  }, MATERIAL_MAX_BLOB_BYTES);
  const init: RequestInit = {
    method: "PATCH",
    body,
    duplex: "half",
    headers: forged ? { "Content-Length": "1" } : undefined,
  };
  const response = await http.fetch(
    new Request("http://localhost/v2/public/test/blobs/uploads/id", init),
  );
  expect(response.status).toBe(413);
  expect(response.headers.get("Connection")).toBe("close");
  expect(received).toBe(REGISTRY_LEGACY_BODY_BYTES);
});

test.each([
  { path: UPLOAD, type: "application/octet-stream" },
  { path: "/api/spack/material-repositories/releases", type: "application/json" },
])("keeps delegated 413 payloads and closes the connection: $path", async ({ path, type }) => {
  const payload = '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"route byte limit"}}';
  const http = createRegistryHttpHandler(
    () =>
      new Response(payload, {
        status: 413,
        headers: {
          "Content-Type": "application/json",
          Connection: "keep-alive",
          "X-Fixture": "route",
        },
      }),
    MATERIAL_MAX_BLOB_BYTES,
  );
  const response = await http.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: new Uint8Array([1]),
    }),
  );
  expect(response.status).toBe(413);
  expect(response.headers.get("Connection")).toBe("close");
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("X-Fixture")).toBe("route");
  expect(await response.text()).toBe(payload);
});

test("preserves a small JSON request, signal, response and unrelated exceptions", async () => {
  const controller = new AbortController();
  const response = new Response("ok", { status: 201 });
  const http = createRegistryHttpHandler(async (request) => {
    expect(request.headers.get("Authorization")).toBe("Bearer fixture");
    expect(await request.json()).toEqual({ value: 1 });
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    return response;
  }, MATERIAL_MAX_BLOB_BYTES);
  expect(
    await http.fetch(
      new Request("http://localhost/api/ordinary-json", {
        method: "POST",
        headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
        body: '{"value":1}',
        signal: controller.signal,
      }),
    ),
  ).toBe(response);
  const failure = new Error("original failure");
  const failing = createRegistryHttpHandler(() => {
    throw failure;
  }, MATERIAL_MAX_BLOB_BYTES);
  await expect(
    failing.fetch(
      new Request("http://localhost/api/ordinary-json", { method: "POST", body: "{}" }),
    ),
  ).rejects.toBe(failure);
});
