// Normalized Anthropic Messages types. Claude Code sends `system` and message
// `content` as either a string or an array; `parseRequest` collapses those unions
// so everything downstream works with the array forms below.
export namespace Ant {
  export interface ContentBlock {
    type: string
    // text / thinking
    text?: string
    thinking?: string
    signature?: string
    // tool_use
    id?: string
    name?: string
    input?: unknown
    // tool_result
    tool_use_id?: string
    content?: unknown
    is_error?: boolean
    // image
    source?: { type?: string; media_type?: string; data?: string }
  }

  export interface SystemBlock {
    type: 'text'
    text: string
  }

  export interface Message {
    role: string
    content: ContentBlock[]
  }

  export interface Tool {
    name?: string
    description?: string
    input_schema?: unknown
  }

  export interface Request {
    model: string
    messages: Message[]
    system: SystemBlock[]
    tools?: Tool[]
    tool_choice?: unknown
    max_tokens?: number
    temperature?: number
    top_p?: number
    stop_sequences?: string[]
    thinking?: { type?: string; budget_tokens?: number }
    output_config?: { effort?: string }
    stream?: boolean
  }

  // Usage as reported back to Claude Code.
  export interface Usage {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
  }

  export interface Response {
    id: string
    type: 'message'
    role: 'assistant'
    model: string
    content: ContentBlock[]
    stop_reason: string
    stop_sequence: null
    usage: Usage
  }

  export interface ErrorResponse {
    type: 'error'
    error: { type: string; message: string }
  }
}
