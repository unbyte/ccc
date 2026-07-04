import type { ReasoningOptions } from '../adaptor'
import { type Ant, toolResultText } from '../anthropic-message'
import type { OAI } from './types'

// Anthropic Messages request -> OpenAI Chat Completions request. One-shot: build a
// transformer around the request and call `transform()` once.
export class RequestTransformer {
  private readonly messages: OAI.Message[] = []

  constructor(
    private readonly req: Ant.Request,
    private readonly reasoning: ReasoningOptions = {},
  ) {}

  transform(): OAI.Request {
    const req = this.req
    this.appendSystem()
    for (const message of req.messages) this.appendMessage(message)

    const out: OAI.Request = { model: req.model, messages: this.messages }

    // o-series reasoning models reject `max_tokens` and require `max_completion_tokens`.
    if (typeof req.max_tokens === 'number') {
      if (isOpenAIOSeries(req.model)) out.max_completion_tokens = req.max_tokens
      else out.max_tokens = req.max_tokens
    }
    if (typeof req.temperature === 'number') out.temperature = req.temperature
    if (typeof req.top_p === 'number') out.top_p = req.top_p
    if (req.stop_sequences?.length) out.stop = req.stop_sequences

    const effort = this.resolveReasoningEffort()
    if (effort) out.reasoning_effort = effort

    const tools = transformTools(req.tools)
    if (tools.length) {
      out.tools = tools
      const toolChoice = transformToolChoice(req.tool_choice)
      if (toolChoice !== undefined) out.tool_choice = toolChoice
    }

    if (req.stream) {
      out.stream = true
      // OpenAI-compatible upstreams omit usage from the SSE tail unless asked.
      out.stream_options = { include_usage: true }
    }

    return out
  }

  private appendSystem() {
    const message = systemMessage(this.req.system)
    if (message) this.messages.push(message)
  }

  private appendMessage(message: Ant.Message) {
    const blocks = message.content
    if (message.role === 'assistant') this.appendAssistant(blocks)
    // Anthropic only sends user/assistant; tool results ride inside user turns.
    else this.appendUser(blocks)
  }

  // tool_result blocks become `role:"tool"` messages that MUST come immediately
  // after the assistant message that made the calls, so we emit them first and any
  // free text/images as a trailing `role:"user"` message.
  private appendUser(blocks: Ant.ContentBlock[]) {
    let text = ''
    const images: OAI.ContentPart[] = []
    let toolResultCount = 0

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          text += block.text ?? ''
          break
        case 'image':
          if (block.source?.data) {
            const mediaType = block.source.media_type ?? 'image/png'
            images.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${block.source.data}` },
            })
          }
          break
        case 'tool_result':
          toolResultCount++
          this.messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id ?? '',
            content: toolResultText(block.content),
          })
          break
      }
    }

    if (images.length > 0) {
      const parts: OAI.ContentPart[] = []
      if (text) parts.push({ type: 'text', text })
      parts.push(...images)
      this.messages.push({ role: 'user', content: parts })
    } else if (text) {
      this.messages.push({ role: 'user', content: text })
    } else if (toolResultCount === 0) {
      // Preserve an otherwise-empty user turn.
      this.messages.push({ role: 'user', content: '' })
    }
  }

  private appendAssistant(blocks: Ant.ContentBlock[]) {
    let content = ''
    const reasoning: string[] = []
    const toolCalls: OAI.ToolCall[] = []

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          content += block.text ?? ''
          break
        case 'thinking':
          if (block.thinking) reasoning.push(block.thinking)
          break
        case 'redacted_thinking':
          // Historical thinking Claude Code re-sends encrypted; a placeholder keeps
          // reasoning backends that require non-empty reasoning_content happy.
          if (this.reasoning.preserveContent) reasoning.push('[redacted thinking]')
          break
        case 'tool_use':
          toolCalls.push({
            id: block.id ?? '',
            type: 'function',
            function: { name: block.name ?? '', arguments: stringifyInput(block.input) },
          })
          break
      }
    }

    const message: OAI.Message = { role: 'assistant', content }
    if (toolCalls.length) {
      message.tool_calls = toolCalls
      if (!content) message.content = null
      // Reasoning backends demand reasoning_content alongside tool calls; other
      // backends reject the field, so only attach it when explicitly enabled.
      if (this.reasoning.preserveContent) {
        message.reasoning_content = reasoning.length ? reasoning.join('\n') : 'tool call'
      }
    }
    this.messages.push(message)
  }

  // Look up the upstream `reasoning_effort` token for this request's model and
  // effort level. A model absent from the map doesn't support reasoning (nothing is
  // sent); a supported model with an unmapped level likewise sends nothing.
  private resolveReasoningEffort() {
    const perModel = this.reasoning.effortMapping?.[this.req.model]
    if (!perModel) return undefined
    const level = this.resolveEffortLevel()
    return level ? perModel[level] : undefined
  }

  // Resolve a Claude effort level. output_config.effort wins; otherwise fall back
  // to thinking.type + budget_tokens (adaptive -> xhigh, enabled -> low/medium/high).
  private resolveEffortLevel() {
    const effort = this.req.output_config?.effort
    if (typeof effort === 'string') return effort

    const thinking = this.req.thinking
    if (thinking?.type === 'adaptive') return 'xhigh'
    if (thinking?.type === 'enabled') {
      const budget = thinking.budget_tokens
      if (typeof budget !== 'number') return 'high'
      if (budget < 4000) return 'low'
      if (budget < 16000) return 'medium'
      return 'high'
    }
    return undefined
  }
}

// Claude Code prepends dynamic `x-anthropic-billing-header:` metadata to `system`.
// Its rotating value changes the prompt prefix every request and defeats upstream
// prefix caching, so drop only a leading occurrence and keep any user-authored text.
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

function stripLeadingBillingHeader(text: string) {
  if (!text.startsWith(BILLING_HEADER_PREFIX)) return text
  const nl = text.search(/[\r\n]/)
  if (nl === -1) return ''
  // Drop the header line's terminator plus one blank separator line that follows.
  return text.slice(nl).replace(/^(\r\n|\r|\n){1,2}/, '')
}

// Normalized Anthropic `system` blocks -> a single leading OpenAI system message.
function systemMessage(system: Ant.SystemBlock[]): OAI.Message | null {
  const parts: string[] = []
  for (const block of system) {
    const text = stripLeadingBillingHeader(block.text)
    if (text) parts.push(text)
  }
  if (!parts.length) return null
  return { role: 'system', content: parts.join('\n') }
}

function transformTools(tools: Ant.Tool[] | undefined) {
  if (!tools?.length) return []
  const out: OAI.Tool[] = []
  for (const tool of tools) {
    // BatchTool is an Anthropic-only orchestration tool with no OpenAI equivalent.
    if (!tool.name?.trim() || (tool as { type?: string }).type === 'BatchTool') continue
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.input_schema),
      },
    })
  }
  return out
}

// Upstreams 400 on malformed schemas, so normalize to a valid JSON Schema object
// and strip the `format: "uri"` keyword many backends reject.
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (
    schema == null ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    Object.keys(schema).length === 0
  ) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const out = cleanSchema(schema as Record<string, unknown>)
  if (out.type !== 'object') out.type = 'object'
  if (
    out.properties == null ||
    typeof out.properties !== 'object' ||
    Array.isArray(out.properties)
  ) {
    out.properties = {}
  }
  return out
}

function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema }
  if (out.format === 'uri') delete out.format
  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    const props: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(out.properties as Record<string, unknown>)) {
      props[key] = isObject(value) ? cleanSchema(value) : value
    }
    out.properties = props
  }
  if (isObject(out.items)) out.items = cleanSchema(out.items)
  return out
}

// Anthropic tool_choice -> OpenAI Chat Completions (note: "any" -> "required").
function transformToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice === 'any' ? 'required' : choice
  if (!isObject(choice)) return undefined
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return typeof choice.name === 'string'
        ? { type: 'function', function: { name: choice.name } }
        : 'auto'
    default:
      return undefined
  }
}

// o1 / o3 / o4-mini ...: leading 'o' followed by a digit.
function isOpenAIOSeries(model: string) {
  return model.length > 1 && model[0] === 'o' && model[1] >= '0' && model[1] <= '9'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Anthropic `tool_use.input` (object) -> the stringified JSON that OpenAI's
// `tool_calls.function.arguments` expects; a pre-stringified input passes through.
function stringifyInput(input: unknown) {
  if (input == null) return '{}'
  if (typeof input === 'string') return input || '{}'
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}
