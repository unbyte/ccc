import type { Ant } from '../anthropic'
import { contentBlocks, stringifyInput, systemText, toolResultText } from '../anthropic'
import type { OAI } from './types'

/** Anthropic Messages request -> OpenAI Chat Completions request. */
export function transformRequest(req: Ant.Request): OAI.Request {
  const messages: OAI.Message[] = []

  const system = systemText(req.system)
  if (system) messages.push({ role: 'system', content: system })

  for (const message of req.messages ?? []) {
    transformMessage(message, messages)
  }

  const out: OAI.Request = { model: req.model, messages }

  if (typeof req.max_tokens === 'number') out.max_tokens = req.max_tokens
  if (typeof req.temperature === 'number') out.temperature = req.temperature
  if (typeof req.top_p === 'number') out.top_p = req.top_p
  if (req.stop_sequences?.length) out.stop = req.stop_sequences

  const tools = transformTools(req.tools)
  if (tools.length) {
    out.tools = tools
    const toolChoice = transformToolChoice(req.tool_choice)
    if (toolChoice !== undefined) out.tool_choice = toolChoice
  }

  if (req.stream) {
    out.stream = true
    out.stream_options = { include_usage: true }
  }

  return out
}

function transformMessage(message: Ant.Message, out: OAI.Message[]) {
  const blocks = contentBlocks(message.content)
  if (message.role === 'user') {
    transformUserMessage(blocks, out)
  } else if (message.role === 'assistant') {
    transformAssistantMessage(blocks, out)
  } else {
    // Fallback: concatenate text into a same-role message.
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    out.push({ role: message.role as OAI.Message['role'], content: text })
  }
}

// tool_result blocks become `role:"tool"` messages that MUST come immediately
// after the assistant message that made the calls, so we emit them first and
// any free text/images as a trailing `role:"user"` message.
function transformUserMessage(blocks: Ant.ContentBlock[], out: OAI.Message[]) {
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
          images.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${block.source.data}` } })
        }
        break
      case 'tool_result':
        toolResultCount++
        out.push({
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
    out.push({ role: 'user', content: parts })
  } else if (text) {
    out.push({ role: 'user', content: text })
  } else if (toolResultCount === 0) {
    // Preserve an otherwise-empty user turn.
    out.push({ role: 'user', content: '' })
  }
}

function transformAssistantMessage(blocks: Ant.ContentBlock[], out: OAI.Message[]) {
  let content = ''
  let reasoning = ''
  const toolCalls: OAI.ToolCall[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content += block.text ?? ''
        break
      case 'thinking':
        reasoning += block.thinking ?? ''
        break
      case 'tool_use':
        // A tool_use block may carry an inline `thinking` field.
        if (block.thinking) reasoning += block.thinking
        toolCalls.push({
          id: block.id ?? '',
          type: 'function',
          function: { name: block.name ?? '', arguments: stringifyInput(block.input) },
        })
        break
    }
  }

  const message: OAI.Message = { role: 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) {
    message.tool_calls = toolCalls
    if (!content) message.content = null
  }
  out.push(message)
}

function transformTools(tools: Ant.Tool[] | undefined) {
  if (!tools?.length) return []
  const out: OAI.Tool[] = []
  for (const tool of tools) {
    if (!tool.name?.trim()) continue
    out.push({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: sanitizeSchema(tool.input_schema) },
    })
  }
  return out
}

// Upstreams 400 on malformed schemas, so normalize to a valid JSON Schema object.
function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema) || Object.keys(schema).length === 0) {
    return { type: 'object', properties: {}, additionalProperties: false }
  }
  const out = { ...(schema as Record<string, unknown>) }
  if (out.type !== 'object') out.type = 'object'
  if (out.properties == null || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
    out.properties = {}
  }
  return out
}

function transformToolChoice(choice: unknown): unknown {
  if (choice == null || typeof choice !== 'object') return undefined
  const { type, name } = choice as { type?: string; name?: string }
  switch (type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      return name ? { type: 'function', function: { name } } : 'auto'
    default:
      return undefined
  }
}
