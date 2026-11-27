export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
    readonly details?: unknown,
  ) {
    super(code);
  }
}
