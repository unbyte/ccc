import { randomBytes } from 'node:crypto'

// Anthropic content/system fields are deliberately typed as `unknown` because
// Claude Code mixes string and array shapes freely.
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

  export interface Message {
    role: string
    content: unknown // string | ContentBlock[]
  }

  export interface Tool {
    name?: string
    description?: string
    input_schema?: unknown
  }

  export interface Request {
    model: string
    messages?: Message[]
    system?: unknown // string | { type: 'text'; text: string }[]
    tools?: Tool[]
    tool_choice?: unknown
    max_tokens?: number
    temperature?: number
    top_p?: number
    stop_sequences?: string[]
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

// Polymorphic accessors that normalize the string | array shapes Claude Code
// sends. Everything downstream works with the normalized forms.

/** Top-level `system`: string OR [{type,text}] -> concatenated text. */
export function systemText(system: unknown) {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system.map((block) => (isObject(block) && typeof block.text === 'string' ? block.text : '')).join('')
  }
  return ''
}

/** Message `content`: string OR [block] -> [block] (a bare string becomes one text block). */
export function contentBlocks(content: unknown): Ant.ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.filter((block) => isObject(block) && typeof block.type === 'string') as Ant.ContentBlock[]
  return []
}

/** A tool_result's `content`: string, or array whose text blocks are concatenated. */
export function toolResultText(content: unknown) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (isObject(block) && typeof block.text === 'string') return block.text
        return ''
      })
      .join('')
  }
  return ''
}

/** `tool_use.input` (object) -> `tool_calls.function.arguments` (stringified JSON). */
export function stringifyInput(input: unknown) {
  if (input == null) return '{}'
  if (typeof input === 'string') return input || '{}'
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}

/** `tool_calls.function.arguments` (string) -> `tool_use.input` (object). */
export function parseArguments(args: string | undefined): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}

export function genId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/** Wrap an HTTP status + message as an Anthropic error response body. */
export function transformError(status: number, message: string): Ant.ErrorResponse {
  return { type: 'error', error: { type: mapErrorType(status), message } }
}

function mapErrorType(status: number) {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 429:
      return 'rate_limit_error'
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
