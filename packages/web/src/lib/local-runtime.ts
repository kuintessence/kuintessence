export interface KqLocal {
  baseUrl: string;
  token?: string;
}

declare global {
  interface Window {
    __KQ_LOCAL__?: KqLocal;
  }
}

export function isLocalMode(): boolean {
  return typeof window !== "undefined" && !!window.__KQ_LOCAL__;
}

export function localApiBase(): string | undefined {
  return typeof window !== "undefined" ? window.__KQ_LOCAL__?.baseUrl : undefined;
}

export function localToken(): string | undefined {
  return typeof window !== "undefined" ? window.__KQ_LOCAL__?.token : undefined;
}
