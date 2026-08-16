/** Anthropic error categories exposed by the adaptor. */
export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'billing_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'timeout_error'
  | 'overloaded_error'
  | 'api_error'

/** Anthropic JSON and SSE error envelope. */
export interface AnthropicErrorEnvelope {
  /** Error envelope discriminator. */
  type: 'error'
  /** Safe public error detail. */
  error: {
    /** Machine-readable error category. */
    type: AnthropicErrorType
    /** Human-readable redacted detail. */
    message: string
  }
}
