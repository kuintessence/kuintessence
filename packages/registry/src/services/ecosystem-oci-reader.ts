import { createHash } from "node:crypto";
import { AppError, ErrorCode } from "@kuintessence/shared";
import {
  parseSignedEcosystemBundle,
  type SignedEcosystemBundle,
} from "./ecosystem-release-service";
import { parseNamespace } from "./namespace";
import type { RegistryService } from "./registry-service";

export const ECOSYSTEM_ARTIFACT_MEDIA_TYPE =
  "application/vnd.kuintessence.ecosystem.release.v1+json";
export const ECOSYSTEM_BUNDLE_MEDIA_TYPE = "application/vnd.kuintessence.ecosystem.bundle.v1+json";
export const MAX_ECOSYSTEM_BUNDLE_BYTES = 32 * 1024 * 1024;
const OCI_IMAGE_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";

export interface EcosystemOciReference {
  repository: string;
  digest: string;
}

export interface EcosystemOciBundle {
  artifactDigest: string;
  bundle: SignedEcosystemBundle;
}

export class EcosystemOciReader {
  constructor(private readonly registry: RegistryService) {}

  async read(reference: EcosystemOciReference): Promise<EcosystemOciBundle> {
    if (!/^sha256:[0-9a-f]{64}$/.test(reference.digest)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Ecosystem OCI import requires an immutable sha256 digest",
        422,
      );
    }
    const repository = await this.registry.findRepository(parseNamespace(reference.repository));
    if (!repository) {
      throw new AppError(ErrorCode.NOT_FOUND, "Ecosystem OCI repository not found", 404);
    }
    const manifestRecord = await this.registry.getManifestByRef(repository.id, reference.digest);
    if (manifestRecord.digest !== reference.digest) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "OCI manifest digest mismatch", 422);
    }
    const manifestBodyDigest = `sha256:${createHash("sha256")
      .update(manifestRecord.body)
      .digest("hex")}`;
    if (
      manifestBodyDigest !== reference.digest ||
      manifestRecord.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "OCI manifest content or media type is invalid",
        422,
      );
    }
    const manifest = parseOciManifest(manifestRecord.body);
    if (manifest.artifactType !== ECOSYSTEM_ARTIFACT_MEDIA_TYPE) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Unexpected ecosystem OCI artifact type", 422);
    }
    const layers = manifest.layers.filter(
      (layer) => layer.mediaType === ECOSYSTEM_BUNDLE_MEDIA_TYPE,
    );
    const layer = layers[0];
    if (layers.length !== 1 || !layer) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Ecosystem OCI artifact must contain exactly one signed bundle layer",
        422,
      );
    }
    if (layer.size > MAX_ECOSYSTEM_BUNDLE_BYTES) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Ecosystem OCI bundle exceeds the ${MAX_ECOSYSTEM_BUNDLE_BYTES} byte limit`,
        413,
      );
    }
    const blob = await this.registry.getBlob(repository.id, layer.digest);
    if (blob.size !== layer.size || blob.size > MAX_ECOSYSTEM_BUNDLE_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI layer size mismatch", 422);
    }
    const { bytes, digest: layerDigest } = await consumeStream(blob.stream, layer.size);
    if (layerDigest !== layer.digest) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI layer digest mismatch", 422);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI layer is not valid JSON", 422);
    }
    const bundle = parseSignedEcosystemBundle(value);
    return { artifactDigest: manifestRecord.digest, bundle };
  }
}

interface OciManifest {
  artifactType?: string;
  layers: Array<{ digest: string; mediaType: string; size: number }>;
}

function parseOciManifest(bytes: Uint8Array): OciManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI manifest is not valid JSON", 422);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI manifest is invalid", 422);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI manifest schema is invalid", 422);
  }
  const layers = manifest.layers.map((layer) => {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Ecosystem OCI layer descriptor is invalid",
        422,
      );
    }
    const descriptor = layer as Record<string, unknown>;
    if (
      typeof descriptor.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest) ||
      typeof descriptor.mediaType !== "string" ||
      typeof descriptor.size !== "number" ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Ecosystem OCI layer descriptor is invalid",
        422,
      );
    }
    return {
      digest: descriptor.digest,
      mediaType: descriptor.mediaType,
      size: descriptor.size,
    };
  });
  return {
    artifactType: typeof manifest.artifactType === "string" ? manifest.artifactType : undefined,
    layers,
  };
}

async function consumeStream(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<{ bytes: Uint8Array; digest: string }> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > expectedSize) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Ecosystem OCI layer exceeds declared size",
        422,
      );
    }
    hash.update(value);
    chunks.push(value);
  }
  if (total !== expectedSize) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Ecosystem OCI layer size mismatch", 422);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, digest: `sha256:${hash.digest("hex")}` };
}
