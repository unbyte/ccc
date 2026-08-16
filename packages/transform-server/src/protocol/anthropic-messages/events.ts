import type {
  AnthropicServerToolUseBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicWebSearchToolResultBlock,
} from './common'
import type { AnthropicErrorEnvelope } from './errors'
import type { AnthropicMessageResponse, AnthropicStopReason, AnthropicUsage } from './response'

/** Incremental content within an open Anthropic content block. */
export type AnthropicContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }

/** Initial content permitted in a streaming block start. */
export type AnthropicStreamContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

/** Ordered Messages SSE event union. */
export type AnthropicMessageStreamEvent =
  | {
      /** Starts the message lifecycle. */
      type: 'message_start'
      /** Initial message with empty content and zero usage. */
      message: AnthropicMessageResponse
    }
  | {
      /** Starts exactly one indexed content block. */
      type: 'content_block_start'
      /** Monotonically increasing block index. */
      index: number
      /** Initial block value. */
      content_block: AnthropicStreamContentBlock
    }
  | {
      /** Appends data to the currently open indexed block. */
      type: 'content_block_delta'
      /** Index previously announced by `content_block_start`. */
      index: number
      /** Type-specific incremental payload. */
      delta: AnthropicContentBlockDelta
    }
  | {
      /** Closes exactly one indexed block. */
      type: 'content_block_stop'
      /** Index being closed. */
      index: number
    }
  | {
      /** Announces terminal metadata after every block has closed. */
      type: 'message_delta'
      /** Final stop information. */
      delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null }
      /** Final usage accounting. */
      usage: AnthropicUsage
    }
  | {
      /** Ends a valid message stream. */
      type: 'message_stop'
    }
  | AnthropicErrorEnvelope
