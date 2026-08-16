import type { JsonSchema, JsonValue } from '../json'
import type { OpenAIInputContent, OpenAIInputImage, OpenAIInputText } from './common'

/** A role-bearing Responses message input item. */
export interface OpenAIInputMessage {
  /** Message item discriminator. */
  type: 'message'
  /** Instruction, human-input, or historical model-output role. */
  role: 'developer' | 'user' | 'assistant'
  /** Ordered typed message parts. */
  content: OpenAIInputContent[]
}

/** Opaque reasoning state replayed into a stateless request. */
export interface OpenAIReasoningInputItem {
  /** Reasoning item discriminator. */
  type: 'reasoning'
  /** Historical summaries are deliberately omitted during replay. */
  summary: []
  /** Historical visible reasoning is deliberately omitted. */
  content: null
  /** Provider-issued encrypted reasoning payload. */
  encrypted_content: string
}

/** Historical function invocation. */
export interface OpenAIFunctionCallInputItem {
  /** Function-call item discriminator. */
  type: 'function_call'
  /** Stable ID shared with its function output. */
  call_id: string
  /** Responses-safe function name. */
  name: string
  /** JSON arguments serialized as a string, never an object. */
  arguments: string
}

/** Historical result of a function invocation. */
export interface OpenAIFunctionCallOutputInputItem {
  /** Function-output item discriminator. */
  type: 'function_call_output'
  /** ID of the matching function call. */
  call_id: string
  /** Scalar output or supported multimodal parts. */
  output: string | Array<OpenAIInputText | OpenAIInputImage>
}

/** Input item subset sent to the Codex Responses backend. */
export type OpenAIResponseInputItem =
  | OpenAIInputMessage
  | OpenAIReasoningInputItem
  | OpenAIFunctionCallInputItem
  | OpenAIFunctionCallOutputInputItem

/** Client function declaration. */
export interface OpenAIFunctionTool {
  /** Function-tool discriminator. */
  type: 'function'
  /** Responses-safe name. */
  name: string
  /** Human-readable guidance. */
  description?: string
  /** Normalized JSON Schema arguments. */
  parameters: JsonSchema
  /** Codex compatibility requires non-strict validation. */
  strict: false
}

/** Server-side Responses web-search declaration. */
export interface OpenAIWebSearchTool {
  /** Web-search tool discriminator. */
  type: 'web_search'
  /** Search restrictions supported by Responses. */
  filters?: { allowed_domains?: string[] }
  /** Approximate caller location. */
  user_location?: Record<string, JsonValue>
}

/** Tool declaration subset sent upstream. */
export type OpenAIResponseTool = OpenAIFunctionTool | OpenAIWebSearchTool

/** Upstream tool-selection policy. */
export type OpenAIResponseToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; name: string }
  | { type: 'web_search' }

/** Stateless request sent to the Codex Responses endpoint. */
export interface OpenAIResponsesRequest {
  /** Caller-selected model ID. */
  model: string
  /** Empty because developer instructions are represented as input items. */
  instructions: ''
  /** Ordered heterogeneous input items. */
  input: OpenAIResponseInputItem[]
  /** Translated tool declarations. */
  tools?: OpenAIResponseTool[]
  /** Model tool-selection behavior. */
  tool_choice?: OpenAIResponseToolChoice
  /** Whether multiple function calls may run concurrently. */
  parallel_tool_calls: boolean
  /** Reasoning effort and optional visible summary output. */
  reasoning: { effort: string; summary?: 'auto' }
  /** Priority execution profile. */
  service_tier?: 'priority'
  /** Upstream always streams, even for downstream JSON callers. */
  stream: true
  /** Requests remain stateless. */
  store: false
  /** Requests encrypted reasoning for later replay. */
  include: ['reasoning.encrypted_content']
  /** Adaptor-owned session cache identifier. */
  prompt_cache_key?: string
}
