import { AppError, ErrorCode } from "@kuintessence/shared";
import { cancelMaterialInput, MATERIAL_MAX_BLOB_BYTES } from "./services/spack-material-storage";

export const REGISTRY_LEGACY_BODY_BYTES = 128 * 1024 ** 2;
const MATERIAL_UPLOAD_PATH = "/api/spack/material-repositories/blobs";

/** Raise Bun's transport ceiling without raising the limits of unrelated routes. */
export function createRegistryHttpHandler(
  handle: (request: Request) => Response | Promise<Response>,
  materialMaxBlobBytes?: number,
) {
  if (
    materialMaxBlobBytes !== undefined &&
    (!Number.isSafeInteger(materialMaxBlobBytes) ||
      materialMaxBlobBytes <= 0 ||
      materialMaxBlobBytes > MATERIAL_MAX_BLOB_BYTES)
  ) {
    throw new Error("Invalid Registry material HTTP body limit");
  }
  return {
    maxRequestBodySize: Math.max(REGISTRY_LEGACY_BODY_BYTES, materialMaxBlobBytes ?? 0),
    async fetch(request: Request): Promise<Response> {
      const materialUpload =
        materialMaxBlobBytes !== undefined &&
        request.method === "POST" &&
        new URL(request.url).pathname === MATERIAL_UPLOAD_PATH &&
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ===
          "application/octet-stream";
      // The material route/store enforce the configured limit on headers AND streamed bytes.
      if (materialUpload) return closeOversizedConnection(await handle(request));

      const tooLarge = () =>
        Response.json(
          { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the byte limit" } },
          // A rejected body is not drained to its HTTP message boundary.
          { status: 413, headers: { Connection: "close" } },
        );
      const length = request.headers.get("Content-Length");
      if (
        length !== null &&
        /^\d+$/.test(length) &&
        BigInt(length) > BigInt(REGISTRY_LEGACY_BODY_BYTES)
      ) {
        if (request.body) cancelMaterialInput(request.body);
        return tooLarge();
      }
      if (!request.body) return handle(request);

      let size = 0;
      let exceeded = false;
      const body = request.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > REGISTRY_LEGACY_BODY_BYTES) {
              exceeded = true;
              throw new AppError(
                ErrorCode.VALIDATION_ERROR,
                "Request body exceeds the byte limit",
                413,
              );
            }
            controller.enqueue(chunk);
          },
        }),
      );
      const init: RequestInit = { body, duplex: "half" };
      try {
        const response = await handle(new Request(request, init));
        // A downstream parser may translate a stream error into a different HTTP status.
        return exceeded ? tooLarge() : closeOversizedConnection(response);
      } catch (error) {
        if (exceeded) return tooLarge();
        throw error;
      } finally {
        if (!body.locked) cancelMaterialInput(body);
      }
    },
  };
}

function closeOversizedConnection(response: Response): Response {
  if (response.status !== 413) return response;
  const headers = new Headers(response.headers);
  headers.set("Connection", "close");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
