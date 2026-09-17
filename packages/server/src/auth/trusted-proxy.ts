import { isIP } from "node:net";

interface ParsedCidr {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

/** Header written only by the Server HTTP entrypoint after socket-peer resolution. */
export const RESOLVED_CLIENT_IP_HEADER = "x-kq-resolved-client-ip";

export function parseTrustedProxyCidrs(value: string): readonly ParsedCidr[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseCidr);
}

export function isTrustedProxyAddress(
  remoteAddress: string | undefined,
  cidrs: readonly ParsedCidr[],
): boolean {
  if (!remoteAddress || cidrs.length === 0) return false;
  const normalized = normalizeAddress(remoteAddress);
  const bytes = parseIpBytes(normalized);
  if (!bytes) return false;
  return cidrs.some((cidr) => cidr.bytes.length === bytes.length && prefixMatches(bytes, cidr));
}

/**
 * Resolves the client address from an HTTP connection's socket peer and XFF
 * chain. An untrusted socket peer always wins over any client-supplied XFF.
 *
 * When the peer is trusted, traverse XFF right-to-left, discarding only known
 * proxy addresses. The first non-proxy address is the client. A malformed
 * chain fails closed to the verified socket peer rather than accepting a
 * partially parsed header.
 */
export function resolveHttpClientIp(input: {
  readonly socketPeer: string | undefined;
  readonly xForwardedFor: string | undefined;
  readonly trustedProxyCidrs: readonly ParsedCidr[];
}): string | undefined {
  const peer = normalizeIpAddress(input.socketPeer);
  if (!peer) return undefined;
  if (!isTrustedProxyAddress(peer, input.trustedProxyCidrs)) return peer;
  if (!input.xForwardedFor?.trim()) return peer;

  const forwarded = input.xForwardedFor.split(",").map((part) => normalizeIpAddress(part.trim()));
  if (forwarded.length === 0 || forwarded.some((address) => !address)) return peer;

  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const address = forwarded[index];
    if (!address) return peer;
    if (!isTrustedProxyAddress(address, input.trustedProxyCidrs)) return address;
  }
  return forwarded[0] ?? peer;
}

function parseCidr(value: string): ParsedCidr {
  const [rawAddress, rawPrefix] = value.split("/");
  const address = normalizeAddress(rawAddress ?? "");
  const bytes = parseIpBytes(address);
  if (!bytes) throw new Error(`invalid trusted proxy CIDR address: ${value}`);
  const maxBits = bytes.length * 8;
  const prefixBits = rawPrefix === undefined ? maxBits : Number(rawPrefix);
  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > maxBits) {
    throw new Error(`invalid trusted proxy CIDR prefix: ${value}`);
  }
  return { bytes, prefixBits };
}

function normalizeAddress(value: string): string {
  const zoneIndex = value.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? value.slice(0, zoneIndex) : value;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

function normalizeIpAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeAddress(value.trim());
  return parseIpBytes(normalized) ? normalized : undefined;
}

function parseIpBytes(value: string): Uint8Array | null {
  const family = isIP(value);
  if (family === 4) {
    const parts = value.split(".").map(Number);
    return parts.length === 4 ? Uint8Array.from(parts) : null;
  }
  if (family !== 6) return null;
  const [headPart, tailPart] = value.split("::");
  const head = parseIpv6Groups(headPart ?? "");
  const tail = parseIpv6Groups(tailPart ?? "");
  if (head === null || tail === null) return null;
  const omitted = 8 - head.length - tail.length;
  if ((tailPart === undefined && omitted !== 0) || omitted < 0) return null;
  const groups = [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
  return Uint8Array.from(groups.flatMap((group) => [group >> 8, group & 0xff]));
}

function parseIpv6Groups(value: string): number[] | null {
  if (!value) return [];
  const groups: number[] = [];
  for (const token of value.split(":")) {
    if (token.includes(".")) {
      const ipv4 = parseIpBytes(token);
      if (!ipv4 || ipv4.length !== 4) return null;
      const [first = 0, second = 0, third = 0, fourth = 0] = ipv4;
      groups.push((first << 8) | second, (third << 8) | fourth);
      continue;
    }
    const group = Number.parseInt(token, 16);
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return null;
    groups.push(group);
  }
  return groups;
}

function prefixMatches(address: Uint8Array, cidr: ParsedCidr): boolean {
  const fullBytes = Math.floor(cidr.prefixBits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== cidr.bytes[index]) return false;
  }
  const remainder = cidr.prefixBits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((address[fullBytes] ?? 0) & mask) === ((cidr.bytes[fullBytes] ?? 0) & mask);
}
