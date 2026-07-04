import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { Ant } from './types'

// Wraps the raw HTTP response with the Anthropic Messages operations the server
// and adaptors need: JSON bodies, error bodies, and SSE streaming. Callers never
// touch the underlying `ServerResponse`.
export class Responder {
  constructor(private readonly res: ServerResponse) {}

  json(status: number, body: unknown) {
    if (this.res.headersSent) {
      this.res.end()
      return
    }
    this.res.writeHead(status, { 'content-type': 'application/json' })
    this.res.end(JSON.stringify(body))
  }

  error(status: number, message: string) {
    this.json(status, transformError(status, message))
  }

  // Open an SSE stream and return the sink each transformer chunk is written to;
  // pair with `end()` once the upstream stream is exhausted.
  stream(): (chunk: string) => void {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    this.res.flushHeaders()
    return (chunk) => this.res.write(chunk)
  }

  end() {
    this.res.end()
  }
}

export function genId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

// Wrap an HTTP status + message as an Anthropic error response body.
function transformError(status: number, message: string): Ant.ErrorResponse {
  return { type: 'error', error: { type: mapErrorType(status), message } }
}

function mapErrorType(status: number) {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 429:
      return 'rate_limit_error'
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error'
  }
}
