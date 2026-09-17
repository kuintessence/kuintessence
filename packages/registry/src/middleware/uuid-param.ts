import { AppError, ErrorCode } from "@kuintessence/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuidParam(value: string | undefined, name: string): string {
  if (!value || !UUID_RE.test(value)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid ${name}: must be a UUID`, 400);
  }
  return value;
}
