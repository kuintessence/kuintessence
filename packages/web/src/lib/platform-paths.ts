export const PLATFORM_API_BASE = "/platform/api";
export const PLATFORM_WS_BASE = "/platform/ws";

export function platformApiUrl(path: string): string {
  return `${PLATFORM_API_BASE}${path}`;
}
