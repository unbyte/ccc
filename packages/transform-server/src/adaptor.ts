import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ant } from './anthropic'

export interface AdaptorOptions {
  /** Upstream base URL, e.g. `https://api.openai.com/v1`. */
  api: string
  /** Forwarded to the upstream as a Bearer token. */
  apiKey?: string
}

export interface AdaptorContext {
  req: IncomingMessage
  res: ServerResponse
  /** Parsed Anthropic Messages request body. */
  anthropic: Ant.Request
}

// Owns a single upstream API shape. The TransformServer handles the HTTP
// plumbing (routing, health, count_tokens, body parsing) and only ever hands
// off the parsed request body.
export abstract class Adaptor {
  protected readonly api: string
  protected readonly apiKey?: string

  constructor({ api, apiKey }: AdaptorOptions) {
    this.api = api
    this.apiKey = apiKey
  }

  abstract handle(ctx: AdaptorContext): Promise<void>
}
