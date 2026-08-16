import type { JsonValue } from '../json'
import type { OpenAIOutputText, OpenAIReasoningTextPart } from './common'

/** Generated assistant message item. */
export interface OpenAIMessageOutputItem {
  /** Optional item ID. */
  id?: string
  /** Message item discriminator. */
  type: 'message'
  /** Output messages are assistant-authored. */
  role: 'assistant'
  /** Item lifecycle status. */
  status?: string
  /** Generated output parts. */
  content: OpenAIOutputText[]
}

/** Model-requested client function call. */
export interface OpenAIFunctionCallOutputItem {
  /** Optional item ID used by streaming events. */
  id?: string
  /** Function-call item discriminator. */
  type: 'function_call'
  /** Stable call identifier. */
  call_id: string
  /** Responses-safe function name. */
  name: string
  /** JSON arguments serialized as a string. */
  arguments: string
  /** Item lifecycle status. */
  status?: string
  /** Compatibility index sometimes embedded by upstreams. */
  output_index?: number
}

/** Opaque and optionally summarized model reasoning. */
export interface OpenAIReasoningOutputItem {
  /** Optional reasoning-item ID. */
  id?: string
  /** Reasoning item discriminator. */
  type: 'reasoning'
  /** Visible summary parts. */
  summary?: OpenAIReasoningTextPart[]
  /** Fallback visible reasoning parts. */
  content?: OpenAIReasoningTextPart[] | null
  /** Provider-issued encrypted replay value. */
  encrypted_content?: string
  /** Item lifecycle status. */
  status?: string
}

/** One sanitized web-search result. */
export interface OpenAIWebSearchResult {
  /** Optional result title. */
  title?: string
  /** Required result URL. */
  url: string
  /** Additional upstream fields ignored by the transformer. */
  [key: string]: JsonValue | undefined
}

/** Server-executed web-search output item. */
export interface OpenAIWebSearchOutputItem {
  /** Stable server-tool item ID. */
  id: string
  /** Web-search discriminator. */
  type: 'web_search_call'
  /** Item lifecycle status. */
  status?: string
  /** Search action and query. */
  action?: { type?: string; query?: string; [key: string]: JsonValue | undefined }
  /** Search result list when included by the backend. */
  results?: OpenAIWebSearchResult[]
  /** Compatibility query field. */
  query?: string
}

/** Output item subset consumed from Responses. */
export type OpenAIResponseOutputItem =
  | OpenAIMessageOutputItem
  | OpenAIFunctionCallOutputItem
  | OpenAIReasoningOutputItem
  | OpenAIWebSearchOutputItem

/** Responses token accounting. */
export interface OpenAIResponseUsage {
  /** Total input tokens, including cached tokens. */
  input_tokens: number
  /** Generated output tokens. */
  output_tokens: number
  /** Optional combined total. */
  total_tokens?: number
  /** Input-token detail. */
  input_tokens_details?: { cached_tokens?: number }
  /** Output-token detail. */
  output_tokens_details?: { reasoning_tokens?: number }
}

/** Terminal or initial Responses object consumed by the transformer. */
export interface OpenAIResponse {
  /** Response identifier. */
  id: string
  /** Object discriminator. */
  object?: 'response'
  /** Model ID used upstream. */
  model: string
  /** Response lifecycle status. */
  status?: string
  /** Ordered heterogeneous output items. */
  output: OpenAIResponseOutputItem[]
  /** Standard incomplete reason. */
  incomplete_details?: { reason?: string } | null
  /** Compatibility stop reason used by some Responses servers. */
  stop_reason?: string
  /** Compatibility stop sequence used by some Responses servers. */
  stop_sequence?: string | null
  /** Final usage, absent from some failures. */
  usage?: OpenAIResponseUsage | null
  /** Failure information on failed responses. */
  error?: { code?: string; type?: string; message?: string } | null
}

/** Standard OpenAI error body. */
export interface OpenAIErrorBody {
  /** Error payload. */
  error: {
    /** Machine-readable category. */
    type?: string
    /** Machine-readable code. */
    code?: string
    /** Human-readable detail. */
    message?: string
  }
}
