// Application error type and helpers. Every error that reaches the client has a stable machine
// readable `code`, a human readable `message`, and an HTTP status.

export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   stable machine-readable code, e.g. "NOT_ENROLLED"
   * @param {string} message message that is safe to show to the user
   * @param {unknown} [details] optional structured details (e.g. field errors)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

export const badRequest = (message, code = 'BAD_REQUEST', details) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Please sign in to continue.', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message, code = 'CONFLICT', details) =>
  new AppError(409, code, message, details);
export const unprocessable = (message, code = 'UNPROCESSABLE', details) =>
  new AppError(422, code, message, details);
export const tooMany = (message = 'Too many requests. Please try again shortly.') =>
  new AppError(429, 'RATE_LIMITED', message);
export const unavailable = (message, code = 'SERVICE_UNAVAILABLE') =>
  new AppError(503, code, message);

/** Build a 422 with per-field messages: fieldErrors({ email: 'Already in use' }) */
export const fieldErrors = (fields, message = 'Please correct the highlighted fields.') =>
  new AppError(422, 'VALIDATION_ERROR', message, { fields });

/** Throw 404 when a lookup returned nothing. */
export function assertFound(value, what = 'Record') {
  if (value === null || value === undefined) throw notFound(what);
  return value;
}
