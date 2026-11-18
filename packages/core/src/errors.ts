export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "locked"
  | "rate_limited"
  | "setup_required"
  | "setup_complete"
  | "provider_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  locked: 423,
  rate_limited: 429,
  setup_required: 409,
  setup_complete: 410,
  provider_error: 502,
};

/** Domain error with a message that is safe to show to the user. */
export class AppError extends Error {
  override name = "AppError";
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError("not_found", `${what} not found`);
export const forbidden = (message = "You do not have permission to do that") => new AppError("forbidden", message);
export const unauthorized = (message = "Sign in required") => new AppError("unauthorized", message);
