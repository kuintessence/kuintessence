export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The Server's error envelope: `{ error: { code, message, details? } }`. */
export interface ApiErrorEnvelope {
  error?: string | { code?: string; message?: string; details?: unknown };
}

export function apiErrorReason(error: ApiError): string | null {
  if (!error.details || typeof error.details !== "object") return null;
  const reason = (error.details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * Shared response unwrap: on non-2xx, parse the error envelope (falling back to
 * an HTTP_ERROR + statusText) and throw ApiError; otherwise return the JSON body.
 * Used by both the CLI and Web API clients (they keep their own transport/auth).
 */
export async function unwrapApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { code: "HTTP_ERROR", message: res.statusText },
    }))) as ApiErrorEnvelope;
    const error = body.error;
    throw new ApiError(
      res.status,
      typeof error === "object" ? (error.code ?? "HTTP_ERROR") : "HTTP_ERROR",
      typeof error === "string" ? error : (error?.message ?? res.statusText),
      typeof error === "object" ? error.details : undefined,
    );
  }
  return res.json() as Promise<T>;
}
