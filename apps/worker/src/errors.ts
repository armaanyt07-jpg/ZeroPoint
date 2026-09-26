/** Error codes returned to clients. Shapes follow SRS section 6. */
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_USER_ID'
  | 'USER_BLOCKED'
  | 'BUDGET_EXCEEDED'
  | 'MISSING_PROVIDER'
  | 'UNSUPPORTED_PROVIDER'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_ERROR'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REQUEST_REJECTED'
  | 'PROVIDER_UNREACHABLE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'SERVICE_UNAVAILABLE'
  | 'CONFIGURATION_ERROR'
  | 'INTERNAL_ERROR';

/** An error that maps directly to a safe, client-facing HTTP response. */
export class ZeroPointError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ZeroPointError';
  }
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function toErrorResponse(error: ZeroPointError): Response {
  return errorResponse(error.status, error.code, error.message, error.headers);
}
