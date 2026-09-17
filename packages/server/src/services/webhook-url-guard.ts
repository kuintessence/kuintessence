import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_IPV4_PATTERNS = [
  /^0\./,
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.168\./,
  /^198\.1[89]\./,
];

export function isPubliclyRoutableHttpUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (host === "") {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    return false;
  }
  if (host === "0.0.0.0" || host === "::" || host === "::1") {
    return false;
  }
  if (host.startsWith("::ffff:")) {
    return false;
  }
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return false;
  }
  if (PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host))) {
    return false;
  }

  return true;
}

export interface ResolvedWebhookAddress {
  address: string;
  family: 4 | 6;
}

export interface ResolvedWebhookTarget {
  url: URL;
  addresses: ResolvedWebhookAddress[];
}

export type WebhookLookup = (hostname: string) => Promise<ReadonlyArray<ResolvedWebhookAddress>>;

const defaultLookup: WebhookLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function resolvePublicWebhookTarget(
  raw: string,
  lookup: WebhookLookup = defaultLookup,
): Promise<ResolvedWebhookTarget> {
  if (!isPubliclyRoutableHttpUrl(raw)) {
    throw new Error("webhook URL is not publicly routable");
  }
  const url = new URL(raw);
  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  const family = isIP(hostname);
  const addresses =
    family === 0
      ? await lookup(hostname)
      : [{ address: hostname, family: family as 4 | 6 } satisfies ResolvedWebhookAddress];
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("webhook hostname resolves to a non-public address");
  }
  return { url, addresses: [...addresses] };
}

export function isPublicAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase());
  if (isIP(normalized) === 4) {
    return (
      !PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(normalized)) && normalized !== "0.0.0.0"
    );
  }
  if (isIP(normalized) !== 6) return false;
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("::ffff:")) return false;
  return true;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
