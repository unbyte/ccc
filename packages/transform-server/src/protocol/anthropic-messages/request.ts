import { isJsonObject, type JsonSchema, type JsonValue } from '../json'
import type {
  AnthropicDocumentBlock,
  AnthropicImageBlock,
  AnthropicMessageRole,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
} from './common'

/** A tool result returned by Claude Code after executing `tool_use`. */
export interface AnthropicToolResultBlock {
  /** Tool-result block discriminator. */
  type: 'tool_result'
  /** Must equal the originating `tool_use.id`. */
  tool_use_id: string
  /** Scalar or multimodal result body. */
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  /** Accepted error annotation; deliberately not forwarded to Responses. */
  is_error?: boolean
}

/** Message content supported by the request transformer. */
export type AnthropicRequestContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string; [key: string]: unknown }

/** One conversation turn. */
export interface AnthropicRequestMessage {
  /** Turn authority and input/output direction. */
  role: AnthropicMessageRole
  /** String shorthand or ordered content blocks. */
  content: string | AnthropicRequestContentBlock[]
}

/** A client-defined function tool. */
export interface AnthropicFunctionTool {
  /** Optional compatibility discriminator. */
  type?: 'custom' | 'function'
  /** Function name presented to the model. */
  name: string
  /** Human-readable function guidance. */
  description?: string
  /** JSON Schema for function arguments. */
  input_schema: JsonSchema
  /** Accepted prompt-cache annotation; not forwarded. */
  cache_control?: unknown
  /** Accepted deferred-loading hint; not forwarded. */
  defer_loading?: boolean
}

/** Anthropic's server-side web-search declaration. */
export interface AnthropicWebSearchTool {
  /** Versioned server-tool discriminator. */
  type: 'web_search_20250305' | 'web_search_20260209'
  /** Declaration name used by a forced tool choice. */
  name: string
  /** Domains the server tool may query. */
  allowed_domains?: string[]
  /** Accepted deny-list; deliberately not forwarded. */
  blocked_domains?: string[]
  /** Approximate caller location forwarded to Responses. */
  user_location?: Record<string, JsonValue>
}

/** Tool declarations accepted by this adaptor. */
export type AnthropicTool = AnthropicFunctionTool | AnthropicWebSearchTool

/** Tool-selection behavior requested by Claude Code. */
export type AnthropicToolChoice =
  | {
      /** Let the model decide whether to call a tool. */
      type: 'auto'
      /** Disable concurrent function calls. */
      disable_parallel_tool_use?: boolean
    }
  | {
      /** Require at least one tool call. */
      type: 'any'
      /** Disable concurrent function calls. */
      disable_parallel_tool_use?: boolean
    }
  | {
      /** Prevent all tool calls. */
      type: 'none'
      /** Disable concurrent function calls. */
      disable_parallel_tool_use?: boolean
    }
  | {
      /** Force the named declared tool. */
      type: 'tool'
      /** Original Anthropic tool name. */
      name: string
      /** Disable concurrent function calls. */
      disable_parallel_tool_use?: boolean
    }

/** Reasoning policy supplied by Claude Code. */
export type AnthropicThinkingConfig =
  | {
      /** Enable budget-based reasoning. */
      type: 'enabled'
      /** Approximate reasoning token budget mapped to an effort tier. */
      budget_tokens?: number
      /** `summarized` requests visible reasoning summaries. */
      display?: string
    }
  | {
      /** Disable reasoning. */
      type: 'disabled'
    }
  | {
      /** Let the model choose a reasoning budget. */
      type: 'adaptive' | 'auto'
      /** `summarized` requests visible reasoning summaries. */
      display?: string
    }

/** Anthropic Messages request subset accepted by the adaptor. */
export interface AnthropicMessageRequest {
  /** Upstream model ID, forwarded unchanged. */
  model: string
  /** Required Anthropic limit; deliberately not forwarded to Responses. */
  max_tokens: number
  /** Ordered full conversation history. */
  messages: AnthropicRequestMessage[]
  /** Developer instructions in string or text-block form. */
  system?: string | AnthropicTextBlock[]
  /** Selects downstream SSE; upstream Responses always streams. */
  stream?: boolean
  /** Client and server tool declarations. */
  tools?: AnthropicTool[]
  /** Tool selection and parallelism. */
  tool_choice?: AnthropicToolChoice
  /** Reasoning configuration. */
  thinking?: AnthropicThinkingConfig
  /** Output controls; only `effort` is translated. */
  output_config?: { effort?: string; [key: string]: JsonValue | undefined }
  /** Priority service selector. */
  service_tier?: string
  /** `fast` selects priority service. */
  speed?: string
  /** Accepted sampling value; deliberately not forwarded. */
  temperature?: number
  /** Accepted nucleus-sampling value; deliberately not forwarded. */
  top_p?: number
  /** Accepted top-k value; deliberately not forwarded. */
  top_k?: number
  /** Accepted stop strings; deliberately not forwarded. */
  stop_sequences?: string[]
  /** Accepted caller metadata; used only by the adaptor for execution scope fallback. */
  metadata?: Record<string, JsonValue>
  /** Accepted extensibility fields not translated by this compatibility path. */
  [key: string]: unknown
}

/** Checks the required top-level Messages request shape at the JSON boundary. */
export function isAnthropicMessageRequest(value: unknown): value is AnthropicMessageRequest {
  if (!isJsonObject(value)) return false
  if (typeof value.model !== 'string' || value.model.length === 0) return false
  if (typeof value.max_tokens !== 'number' || !Number.isFinite(value.max_tokens)) return false
  if (!Array.isArray(value.messages)) return false
  return value.messages.every(
    (message) =>
      isJsonObject(message) &&
      ['user', 'assistant', 'system'].includes(String(message.role)) &&
      (typeof message.content === 'string' || Array.isArray(message.content)),
  )
}
