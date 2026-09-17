import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ECOSYSTEM_ARTIFACT_MEDIA_TYPE,
  ECOSYSTEM_BUNDLE_MEDIA_TYPE,
  EcosystemOciReader,
  MAX_ECOSYSTEM_BUNDLE_BYTES,
} from "./ecosystem-oci-reader";
import type { RegistryService } from "./registry-service";

const OCI_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(
  options: { corruptLayer?: boolean; layerSize?: number; manifestMediaType?: string } = {},
) {
  let blobReads = 0;
  const bundleBytes = new TextEncoder().encode(
    JSON.stringify({
      manifest: {
        schemaVersion: 1,
        releaseKey: "test",
        version: "1.0.0",
        provenance: {},
        assets: [
          {
            ecosystemKey: "software/test",
            kind: "spack-package",
            name: "Test",
            version: "1.0.0",
            payload: {},
            provenance: {},
            licensePolicy: {},
          },
        ],
      },
      signingKeyId: "test",
      signature: "test",
    }),
  );
  const declaredLayerBytes = options.corruptLayer
    ? new TextEncoder().encode("x".repeat(bundleBytes.byteLength))
    : bundleBytes;
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 2,
      artifactType: ECOSYSTEM_ARTIFACT_MEDIA_TYPE,
      layers: [
        {
          digest: digest(declaredLayerBytes),
          mediaType: ECOSYSTEM_BUNDLE_MEDIA_TYPE,
          size: options.layerSize ?? bundleBytes.byteLength,
        },
      ],
    }),
  );
  const manifestDigest = digest(manifestBytes);
  const registry = {
    findRepository: async () => ({ id: "repository" }),
    getManifestByRef: async () => ({
      body: manifestBytes,
      digest: manifestDigest,
      mediaType: options.manifestMediaType ?? OCI_MEDIA_TYPE,
    }),
    getBlob: async () => {
      blobReads += 1;
      return {
        size: bundleBytes.byteLength,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bundleBytes);
            controller.close();
          },
        }),
      };
    },
  } as unknown as RegistryService;
  return {
    reader: new EcosystemOciReader(registry),
    reference: { repository: "public/scientific-ecosystem", digest: manifestDigest },
    blobReads: () => blobReads,
  };
}

describe("EcosystemOciReader", () => {
  test("reads a signed bundle through an immutable OCI manifest digest", async () => {
    const { reader, reference } = fixture();
    const result = await reader.read(reference);
    expect(result.artifactDigest).toBe(reference.digest);
    expect(result.bundle.manifest.releaseKey).toBe("test");
  });

  test("rejects a layer whose bytes do not match its descriptor digest", async () => {
    const { reader, reference } = fixture({ corruptLayer: true });
    expect(reader.read(reference)).rejects.toThrow("layer digest mismatch");
  });

  test("rejects a non-OCI image manifest media type", async () => {
    const { reader, reference } = fixture({
      manifestMediaType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    expect(reader.read(reference)).rejects.toThrow("content or media type");
  });

  test("rejects ecosystem bundles above 32 MiB before opening the blob", async () => {
    const { reader, reference, blobReads } = fixture({
      layerSize: MAX_ECOSYSTEM_BUNDLE_BYTES + 1,
    });
    expect(reader.read(reference)).rejects.toThrow("exceeds");
    expect(blobReads()).toBe(0);
  });
});
