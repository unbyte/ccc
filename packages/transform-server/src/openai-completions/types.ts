export namespace OAI {
  export interface ContentPart {
    type: 'text' | 'image_url'
    text?: string
    image_url?: { url: string }
  }

  export interface ToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }

  export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | ContentPart[] | null
    reasoning_content?: string
    tool_calls?: ToolCall[]
    tool_call_id?: string
  }

  export interface Tool {
    type: 'function'
    function: { name: string; description?: string; parameters: unknown }
  }

  export interface Request {
    model: string
    messages: Message[]
    tools?: Tool[]
    tool_choice?: unknown
    max_tokens?: number
    // o-series models reject max_tokens and require max_completion_tokens.
    max_completion_tokens?: number
    temperature?: number
    top_p?: number
    stop?: string[]
    reasoning_effort?: string
    stream?: boolean
    stream_options?: { include_usage: boolean }
  }

  export interface Usage {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    // Anthropic-style cache fields some compatible servers return directly.
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    // DeepSeek-style cache hit accounting.
    prompt_cache_hit_tokens?: number
  }

  // A non-streaming assistant message may carry text either as a plain string or
  // as content parts (text / output_text / refusal), plus a message-level refusal.
  export interface ResponseMessage {
    content?: string | Array<{ type?: string; text?: string; refusal?: string }> | null
    reasoning_content?: string
    refusal?: string
    tool_calls?: ToolCall[]
    // Legacy single-call shape from older / proxied backends.
    function_call?: { id?: string; name?: string; arguments?: unknown }
  }

  export interface Response {
    id?: string
    choices?: Array<{ message?: ResponseMessage; finish_reason?: string }>
    usage?: Usage
  }

  export interface StreamToolCall {
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }

  export interface StreamChunk {
    choices?: Array<{
      delta?: {
        content?: string | null
        reasoning_content?: string | null
        // OpenRouter / Kimi use `reasoning`; DeepSeek uses `reasoning_content`.
        reasoning?: string | null
        tool_calls?: StreamToolCall[]
      }
      finish_reason?: string | null
    }>
    usage?: Usage
  }
}
