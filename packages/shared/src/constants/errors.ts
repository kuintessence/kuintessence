export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CP_GOVERNANCE_WRITE_DISABLED: "CP_GOVERNANCE_WRITE_DISABLED",
  AGENT_OFFLINE: "AGENT_OFFLINE",
  QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",
  QUEUE_INVENTORY_UNAVAILABLE: "QUEUE_INVENTORY_UNAVAILABLE",
  JOB_DISPATCH_FAILED: "JOB_DISPATCH_FAILED",
  JOB_LOG_UNAVAILABLE: "JOB_LOG_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  EXPORT_FORMAT_NOT_SUPPORTED: "EXPORT_FORMAT_NOT_SUPPORTED",
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorJson {
  error: {
    code: ErrorCodeName;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCodeName,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON(): AppErrorJson {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
      },
    };
  }
}
