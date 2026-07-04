import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Ant } from './anthropic'

export interface ReasoningOptions {
  /**
   * Emit `reasoning_content` on assistant tool-call messages (openai-completions
   * transform). Required by Kimi/DeepSeek-style reasoning backends; rejected by
   * strict OpenAI backends, so it defaults off.
   */
  preserveContent?: boolean
  /**
   * Per-model reasoning support: model id -> (Claude effort level -> the exact
   * upstream `reasoning_effort` token). A model absent from the map is treated as
   * not supporting reasoning, so no `reasoning_effort` is sent for it.
   */
  effortMapping?: Record<string, Record<string, string>>
}

export interface AdaptorOptions {
  /** Upstream base URL, e.g. `https://api.openai.com/v1`. */
  api: string
  /** Forwarded to the upstream as a Bearer token. */
  apiKey?: string
  /** Configures reasoning behavior for the adaptor. */
  reasoning?: ReasoningOptions
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
  protected readonly reasoning?: ReasoningOptions

  constructor({ api, apiKey, reasoning }: AdaptorOptions) {
    this.api = api
    this.apiKey = apiKey
    this.reasoning = reasoning
  }

  abstract handle(ctx: AdaptorContext): Promise<void>
}
