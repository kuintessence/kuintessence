import { isIPv4 } from "node:net";

type UpstreamCategory =
  | "policy"
  | "proxy"
  | "http"
  | "integrity"
  | "timeout"
  | "cancelled"
  | "busy"
  | "unavailable"
  | "io";

const ERRORS = {
  policy: [422, "Spack upstream request is not permitted"],
  proxy: [502, "Spack upstream proxy connection failed"],
  http: [502, "Spack upstream did not return a complete successful response"],
  integrity: [422, "Spack upstream content does not match its expected digest or size"],
  timeout: [408, "Spack upstream transfer timed out"],
  cancelled: [408, "Spack upstream import was cancelled; check for a committed result"],
  busy: [429, "Spack upstream import capacity is exhausted"],
  unavailable: [503, "Spack upstream import is not configured"],
  io: [500, "Spack upstream staging failed"],
} as const;

export class SpackUpstreamError extends Error {
  readonly status;
  readonly code;

  constructor(readonly category: UpstreamCategory) {
    super(ERRORS[category][1]);
    this.name = "SpackUpstreamError";
    this.status = ERRORS[category][0];
    this.code = `SPACK_UPSTREAM_${category.toUpperCase()}`;
  }
}

export function isPublicIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function parseUrl(raw: string): URL {
  if (
    raw.length > 4096 ||
    raw.trim() !== raw ||
    raw.includes("\\") ||
    hasControls(raw, true)
  ) {
    throw new SpackUpstreamError("policy");
  }
  try {
    return new URL(raw);
  } catch {
    throw new SpackUpstreamError("policy");
  }
}

function targetUrl(raw: string): URL {
  const url = parseUrl(raw);
  const host = url.hostname;
  if (
    !/^https:\/\//i.test(raw) ||
    url.protocol !== "https:" ||
    (url.port !== "" && url.port !== "443") ||
    url.username ||
    url.password ||
    raw.slice(raw.indexOf("//") + 2).split("/")[0]?.includes("@") ||
    raw.includes("?") ||
    raw.includes("#") ||
    !host.includes(".") ||
    host.endsWith(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|home\.arpa)$/.test(host) ||
    (isIPv4(host) && !isPublicIPv4(host))
  ) {
    throw new SpackUpstreamError("policy");
  }
  return url;
}

export function validateUpstreamUrl(raw: string, origins: readonly string[]): URL {
  const url = targetUrl(raw);
  if (!origins.includes(url.origin)) throw new SpackUpstreamError("policy");
  return url;
}

export function parseUpstreamOrigins(raw: string): string[] {
  try {
    const input: unknown = JSON.parse(raw);
    if (!Array.isArray(input) || input.length > 100) throw new SpackUpstreamError("policy");
    const origins = input.map((item) => {
      if (typeof item !== "string") throw new SpackUpstreamError("policy");
      const url = targetUrl(item);
      if (item !== url.origin) throw new SpackUpstreamError("policy");
      return url.origin;
    });
    if (new Set(origins).size !== origins.length) throw new SpackUpstreamError("policy");
    return origins;
  } catch {
    throw new SpackUpstreamError("policy");
  }
}

export function parseUpstreamProxy(raw: string): string {
  const url = parseUrl(raw);
  try {
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/") ||
      raw.includes("?") ||
      raw.includes("#") ||
      hasControls(username + password) ||
      Buffer.byteLength(username) > 255 ||
      Buffer.byteLength(password) > 255
    ) {
      throw new SpackUpstreamError("policy");
    }
    // URL strips :80/:443, whereas curl's omitted proxy port can mean 1080.
    const port =
      url.port || (url.protocol === "http:" ? "80" : url.protocol === "https:" ? "443" : "1080");
    const auth = url.username || url.password ? `${url.username}:${url.password}@` : "";
    return `${url.protocol}//${auth}${url.hostname}:${port}`;
  } catch {
    throw new SpackUpstreamError("policy");
  }
}

function hasControls(value: string, includeSpace = false): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < (includeSpace ? 33 : 32) || code === 127;
  });
}
