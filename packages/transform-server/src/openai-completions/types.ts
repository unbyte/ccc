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
    temperature?: number
    top_p?: number
    stop?: string[]
    stream?: boolean
    stream_options?: { include_usage: boolean }
  }

  export interface Usage {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    // DeepSeek-style cache accounting
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }

  export interface Response {
    id?: string
    model?: string
    choices?: Array<{ message?: Message; finish_reason?: string }>
    usage?: Usage
  }

  export interface StreamToolCall {
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }

  export interface StreamChunk {
    id?: string
    choices?: Array<{
      delta?: {
        content?: string | null
        reasoning_content?: string | null
        tool_calls?: StreamToolCall[]
      }
      finish_reason?: string | null
    }>
    usage?: Usage
  }
}
