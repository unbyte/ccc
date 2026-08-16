import type { ServerResponse } from 'node:http'
import type { AnthropicErrorEnvelope, AnthropicErrorType } from '../../protocol/anthropic-messages'

/** Error with an Anthropic-compatible HTTP status and category. */
export class AdaptorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: AnthropicErrorType,
  ) {
    super(message)
  }
}

/** Maps an HTTP status to the Anthropic error taxonomy. */
export function anthropicErrorType(status: number): AnthropicErrorType {
  if (status === 401) return 'authentication_error'
  if (status === 402) return 'billing_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 504) return 'timeout_error'
  if (status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** Constructs a safe Anthropic error envelope. */
export function errorEnvelope(type: AnthropicErrorType, message: string): AnthropicErrorEnvelope {
  return { type: 'error', error: { type, message } }
}

/** Writes one JSON response. */
export function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

/** Converts unknown implementation failures into safe public errors. */
export function normalizeAdaptorError(error: unknown) {
  if (error instanceof AdaptorError) return error
  if (error instanceof SyntaxError)
    return new AdaptorError(error.message, 400, 'invalid_request_error')
  if (error instanceof Error && error.name === 'AbortError') {
    return new AdaptorError('Request was aborted', 499, 'invalid_request_error')
  }
  return new AdaptorError(
    error instanceof Error ? error.message : 'Unexpected transform server error',
    500,
    'api_error',
  )
}
