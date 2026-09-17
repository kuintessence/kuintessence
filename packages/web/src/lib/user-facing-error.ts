type ErrorShape = {
  status?: unknown;
  code?: unknown;
  details?: unknown;
  message?: unknown;
};

type Language = "zh" | "en";

const COPY: Record<
  Language,
  {
    unauthorized: string;
    forbidden: string;
    notFound: string;
    conflict: string;
    validation: string;
    rateLimited: string;
    unavailable: string;
    unknown: string;
  }
> = {
  zh: {
    unauthorized: "登录状态已失效，请重新登录。",
    forbidden: "当前账号没有执行此操作的权限，请联系组织管理员或切换组织后重试。",
    notFound: "资源不存在、已删除或当前不可见，请刷新后重试。",
    conflict: "资源状态已发生变化，请刷新后重试。",
    validation: "提交内容无法处理，请检查输入后重试。",
    rateLimited: "操作过于频繁，请稍后再试。",
    unavailable: "平台服务暂时不可用，请稍后重试。",
    unknown: "操作未完成，请稍后重试。",
  },
  en: {
    unauthorized: "Your session has expired. Please sign in again.",
    forbidden:
      "Your account does not have permission to perform this action. Contact your organization administrator or switch organizations and try again.",
    notFound:
      "This resource may not exist, have been deleted, or be unavailable to your account. Refresh and try again.",
    conflict: "The resource changed while you were working. Refresh and try again.",
    validation: "The request could not be processed. Check the inputs and try again.",
    rateLimited: "There have been too many requests. Please try again shortly.",
    unavailable: "The platform is temporarily unavailable. Please try again shortly.",
    unknown: "The operation did not complete. Please try again shortly.",
  },
};

function language(): Language {
  let current = "";
  try {
    const stored = localStorage.getItem("kq.lang");
    if (stored) current = stored;
  } catch {
    // Browser storage may be unavailable in private mode.
  }
  if (!current && typeof navigator !== "undefined") {
    current = navigator.language ?? "";
  }
  return current.startsWith("en") ? "en" : "zh";
}

function asShape(error: unknown): ErrorShape | null {
  if (!error || typeof error !== "object") return null;
  return error as ErrorShape;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function codeValue(error: ErrorShape, details: unknown): string | null {
  const direct = stringValue(error.code);
  if (direct) return direct.toUpperCase();
  if (!details || typeof details !== "object") return null;
  return stringValue((details as { reason?: unknown }).reason)?.toUpperCase() ?? null;
}

function isTechnicalMessage(message: string): boolean {
  return (
    /^[A-Z][A-Z0-9_.-]{2,}$/.test(message.trim()) ||
    /authorization denied|access denied|forbidden|unauthorized|permission denied|failed to fetch|network error|econn|enotfound|timed? ?out|http\s*\d{3}|status\s*code|internal server|non-json|stack trace/i.test(
      message,
    )
  );
}

function isNetworkMessage(message: string): boolean {
  return /failed to fetch|network error|network request|econn|enotfound|timed? ?out|timeout/i.test(
    message,
  );
}

function isLocalValidationMessage(error: unknown, message: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  if (name === "ZodError" || name === "YAMLParseError") return true;
  return /^(yaml|json)\b/i.test(message.trim());
}

function isRestrictedExecutionMessage(message: string): boolean {
  return (
    /authorization denied|not authorized|\bforbidden\b|\bunauthorized\b|http\s*\d{3}|status\s*code|internal server|stack trace|(?:^|\n)\s*at\s+\S+|failed to fetch|network error|econn|enotfound|sqlstate|postgres|drizzle|sqlite(?:error)?|database disk image/i.test(
      message,
    ) ||
    /(?:authorization|proxy-authorization):\s*(?:bearer|basic)|\b(?:bearer|basic)\s+[a-z0-9._~+/-]+=*|(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|credential|private[_-]?key|token|secret|password)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(
      message,
    )
  );
}

/**
 * Present persisted scheduler or scientific-program failure details. Unlike
 * transport errors, these messages are useful experiment diagnostics and are
 * preserved unless they contain platform authorization, network, stack, or
 * secret-bearing internals.
 */
export function toUserFacingExecutionFailure(message: unknown, fallback?: string): string {
  const value = stringValue(message);
  const safeFallback = fallback && !isTechnicalMessage(fallback) ? fallback : undefined;
  if (!value || isRestrictedExecutionMessage(value)) {
    return safeFallback || COPY[language()].unknown;
  }
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}

/**
 * Convert transport and API failures into text suitable for a scientific user.
 * The original Error fields remain untouched for logs, retry decisions, and
 * support diagnostics; only the returned value is intended for UI rendering.
 */
export function toUserFacingError(error: unknown, fallback?: string): string {
  const lang = language();
  const copy = COPY[lang];
  const safeFallback = fallback && !isTechnicalMessage(fallback) ? fallback : undefined;
  const shape = asShape(error);
  const status = statusValue(shape?.status);
  const details = shape?.details;
  const code = shape ? codeValue(shape, details) : null;
  const reason =
    details && typeof details === "object"
      ? stringValue((details as { reason?: unknown }).reason)?.toUpperCase()
      : null;
  const effectiveCode = code ?? reason;

  if (status === 401 || effectiveCode === "UNAUTHORIZED") return copy.unauthorized;
  if (
    status === 403 ||
    effectiveCode === "FORBIDDEN" ||
    effectiveCode === "AUTHORIZATION_DENIED" ||
    effectiveCode === "PERMISSION_DENIED"
  ) {
    return copy.forbidden;
  }
  if (status === 404 || effectiveCode === "NOT_FOUND") return copy.notFound;
  if (status === 409 || effectiveCode === "CONFLICT") return copy.conflict;
  if (
    status === 400 ||
    status === 422 ||
    effectiveCode === "VALIDATION_ERROR" ||
    effectiveCode === "INVALID_ARGUMENT" ||
    effectiveCode === "EXPORT_FORMAT_NOT_SUPPORTED"
  ) {
    return safeFallback || copy.validation;
  }
  if (status === 429 || effectiveCode === "RATE_LIMITED") return copy.rateLimited;
  if (
    status === 408 ||
    (status !== null && status >= 500) ||
    effectiveCode === "NETWORK_ERROR" ||
    effectiveCode === "AGENT_OFFLINE" ||
    effectiveCode === "TERMINAL_AGENT_UNAVAILABLE" ||
    effectiveCode === "TERMINAL_EXEC_TIMEOUT" ||
    effectiveCode === "REGISTRY_UNREACHABLE" ||
    effectiveCode === "SERVICE_UNAVAILABLE"
  ) {
    return safeFallback || copy.unavailable;
  }

  const message = stringValue(shape?.message) ?? (error instanceof Error ? error.message : null);
  if (message && isNetworkMessage(message)) return safeFallback || copy.unavailable;
  if (message && isLocalValidationMessage(error, message)) return safeFallback || message;
  return safeFallback || copy.unknown;
}
