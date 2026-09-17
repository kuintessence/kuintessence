import { isIP } from "node:net";
import { z } from "zod";

const dedicatedAbsolutePath = (name: string) =>
  z
    .string()
    .refine(
      (value) => value.startsWith("/") && value !== "/" && !value.split("/").includes(".."),
      `${name} must be a dedicated absolute path without parent traversal`,
    );

const sandboxRuntimeDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const MAX_SANDBOX_RUNTIME_OCI_REF_LENGTH = 512;
const MAX_SANDBOX_RUNTIME_OCI_REPOSITORY_LENGTH = 255;
const MAX_SANDBOX_RUNTIME_OCI_COMPONENT_LENGTH = 255;
const MAX_SANDBOX_RUNTIME_OCI_TAG_LENGTH = 128;

function isAsciiLowerAlphaNumeric(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiLowerAlphaNumeric(code) || (code >= 0x41 && code <= 0x5a);
}

function hasUnsafeOciCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || code > 0x7e) return true;
  }
  return false;
}

function isValidOciPort(value: string): boolean {
  if (value.length === 0 || value.length > 5) return false;
  let port = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
    port = port * 10 + code - 0x30;
  }
  return port >= 1 && port <= 65_535;
}

function isValidOciDnsHost(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !isAsciiAlphaNumeric(label.charCodeAt(0) ?? 0) ||
      !isAsciiAlphaNumeric(label.charCodeAt(label.length - 1) ?? 0)
    ) {
      return false;
    }
    for (let index = 1; index < label.length - 1; index += 1) {
      const code = label.charCodeAt(index);
      if (isAsciiAlphaNumeric(code) || code === 0x2d) continue;
      return false;
    }
  }
  return true;
}

function isValidOciRegistry(value: string): boolean {
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket <= 1 || value.indexOf("]", closingBracket + 1) !== -1) return false;
    const host = value.slice(1, closingBracket);
    if (host.includes("%") || host.includes(".") || isIP(host) !== 6) return false;
    const suffix = value.slice(closingBracket + 1);
    return suffix === "" || (suffix.startsWith(":") && isValidOciPort(suffix.slice(1)));
  }

  const firstColon = value.indexOf(":");
  if (firstColon >= 0) {
    if (value.indexOf(":", firstColon + 1) !== -1) return false;
    const host = value.slice(0, firstColon);
    if (!isValidOciPort(value.slice(firstColon + 1))) return false;
    return isIP(host) === 4 || isValidOciDnsHost(host);
  }

  return isIP(value) === 4 || isValidOciDnsHost(value);
}

function isOciRegistryCandidate(firstSegment: string, segmentCount: number): boolean {
  if (segmentCount <= 1) return false;
  return (
    firstSegment.startsWith("[") ||
    firstSegment.includes(":") ||
    firstSegment === "localhost" ||
    firstSegment.includes(".") ||
    isIP(firstSegment) === 4 ||
    firstSegment !== firstSegment.toLowerCase()
  );
}

function isValidOciRepositoryComponent(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_SANDBOX_RUNTIME_OCI_COMPONENT_LENGTH ||
    value === "." ||
    value === ".." ||
    value.includes("..")
  ) {
    return false;
  }
  if (
    !isAsciiLowerAlphaNumeric(value.charCodeAt(0) ?? 0) ||
    !isAsciiLowerAlphaNumeric(value.charCodeAt(value.length - 1) ?? 0)
  ) {
    return false;
  }
  let index = 0;
  while (index < value.length) {
    while (index < value.length && isAsciiLowerAlphaNumeric(value.charCodeAt(index))) {
      index += 1;
    }
    if (index === value.length) return true;
    const separator = value.charCodeAt(index);
    if (separator === 0x2e) {
      index += 1;
    } else if (separator === 0x5f) {
      index += 1;
      if (value.charCodeAt(index) === 0x5f) index += 1;
    } else if (separator === 0x2d) {
      while (value.charCodeAt(index) === 0x2d) index += 1;
    } else {
      return false;
    }
    if (index === value.length || !isAsciiLowerAlphaNumeric(value.charCodeAt(index))) {
      return false;
    }
  }
  return false;
}

function isValidOciTag(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SANDBOX_RUNTIME_OCI_TAG_LENGTH) return false;
  const first = value.charCodeAt(0) ?? 0;
  if (!isAsciiAlphaNumeric(first) && first !== 0x5f) return false;
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (isAsciiAlphaNumeric(code) || code === 0x5f || code === 0x2e || code === 0x2d) continue;
    return false;
  }
  return true;
}

function isValidSandboxRuntimeDigest(value: string): boolean {
  if (value.length !== 71 || !value.startsWith("sha256:")) return false;
  for (let index = 7; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isDigit = code >= 0x30 && code <= 0x39;
    const isLowerHex = code >= 0x61 && code <= 0x66;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

// Keep untrusted OCI references on a linear, segment-by-segment validation path.
function parseSandboxRuntimeOciDigestRef(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_SANDBOX_RUNTIME_OCI_REF_LENGTH ||
    value.startsWith("/") ||
    hasUnsafeOciCharacter(value)
  ) {
    return undefined;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return undefined;
  const digest = value.slice(at + 1);
  if (!isValidSandboxRuntimeDigest(digest)) return undefined;

  const name = value.slice(0, at);
  const segments = name.split("/");
  if (segments.some((segment) => segment.length === 0)) return undefined;
  const firstSegment = segments[0] ?? "";
  const hasRegistry = isOciRegistryCandidate(firstSegment, segments.length);
  if (hasRegistry && !isValidOciRegistry(firstSegment)) return undefined;
  const repositorySegments = segments.slice(hasRegistry ? 1 : 0);
  if (repositorySegments.length === 0) return undefined;

  const lastRepositorySegment = repositorySegments.at(-1) ?? "";
  const tagSeparator = lastRepositorySegment.indexOf(":");
  const repositoryLast =
    tagSeparator >= 0 ? lastRepositorySegment.slice(0, tagSeparator) : lastRepositorySegment;
  if (tagSeparator >= 0 && !isValidOciTag(lastRepositorySegment.slice(tagSeparator + 1))) {
    return undefined;
  }
  const normalizedRepositorySegments = [...repositorySegments.slice(0, -1), repositoryLast];
  const repository = normalizedRepositorySegments.join("/");
  if (
    repository.length > MAX_SANDBOX_RUNTIME_OCI_REPOSITORY_LENGTH ||
    normalizedRepositorySegments.some((segment) => !isValidOciRepositoryComponent(segment))
  ) {
    return undefined;
  }
  return digest;
}

const sandboxRuntimeOciDigestRef = z
  .string()
  .max(MAX_SANDBOX_RUNTIME_OCI_REF_LENGTH)
  .refine(
    (value) => parseSandboxRuntimeOciDigestRef(value) !== undefined,
    "Sandbox OCI runtime must be a safe digest-pinned image reference",
  );

export const SandboxRuntimeCacheConfigSchema = z
  .record(
    sandboxRuntimeDigest,
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("OCI"),
        localPath: sandboxRuntimeOciDigestRef,
        signatureVerified: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("SIF"),
        localPath: dedicatedAbsolutePath("Sandbox runtime path"),
        signatureVerified: z.boolean(),
      }),
    ]),
  )
  .superRefine((cache, ctx) => {
    for (const [digest, runtime] of Object.entries(cache)) {
      if (runtime.kind !== "OCI") continue;
      const refDigest = parseSandboxRuntimeOciDigestRef(runtime.localPath);
      if (refDigest !== digest) {
        ctx.addIssue({
          code: "custom",
          path: [digest, "localPath"],
          message: "OCI runtime digest must match its runtime cache key",
        });
      }
    }
  });
