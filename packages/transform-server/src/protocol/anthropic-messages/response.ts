import type {
  AnthropicServerToolUseBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicWebSearchToolResultBlock,
} from './common'

/** Why Anthropic stopped generating the message. */
export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded'
  | null

/** Token usage in Anthropic accounting semantics. */
export interface AnthropicUsage {
  /** Non-cached input tokens. */
  input_tokens: number
  /** Generated output tokens. */
  output_tokens: number
  /** Input tokens served from the upstream cache. */
  cache_read_input_tokens?: number
  /** Input tokens written to a cache, when known. */
  cache_creation_input_tokens?: number
}

/** Blocks returned in a completed Messages response. */
export type AnthropicResponseContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

/** A complete Anthropic-compatible assistant message. */
export interface AnthropicMessageResponse {
  /** Upstream response ID. */
  id: string
  /** Message object discriminator. */
  type: 'message'
  /** Responses are always assistant-authored. */
  role: 'assistant'
  /** Upstream model ID. */
  model: string
  /** Ordered response content. */
  content: AnthropicResponseContentBlock[]
  /** Generation termination reason. */
  stop_reason: AnthropicStopReason
  /** Matching stop string when applicable. */
  stop_sequence: string | null
  /** Final token usage. */
  usage: AnthropicUsage
}

/** Local token-count endpoint response. */
export interface AnthropicTokenCountResponse {
  /** Estimated token count for translated input. */
  input_tokens: number
}
