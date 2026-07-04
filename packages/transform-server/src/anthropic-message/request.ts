import type { Ant } from './types'

// Parse an untrusted Claude Code request body into a normalized `Ant.Request`.
// Only the polymorphic `system`/`content` unions are collapsed into arrays; other
// fields are trusted as-is, matching the blind cast this replaced.
export function parseRequest(raw: unknown): Ant.Request {
  const obj: Record<string, unknown> = isObject(raw) ? raw : {}
  return {
    model: obj.model as string,
    system: normalizeSystem(obj.system),
    messages: normalizeMessages(obj.messages),
    tools: obj.tools as Ant.Tool[] | undefined,
    tool_choice: obj.tool_choice,
    max_tokens: obj.max_tokens as number | undefined,
    temperature: obj.temperature as number | undefined,
    top_p: obj.top_p as number | undefined,
    stop_sequences: obj.stop_sequences as string[] | undefined,
    thinking: obj.thinking as Ant.Request['thinking'],
    output_config: obj.output_config as Ant.Request['output_config'],
    stream: obj.stream as boolean | undefined,
  }
}

// string -> one text block; array -> the text-bearing blocks; anything else -> [].
function normalizeSystem(system: unknown): Ant.SystemBlock[] {
  if (typeof system === 'string') return system ? [{ type: 'text', text: system }] : []
  if (!Array.isArray(system)) return []
  const blocks: Ant.SystemBlock[] = []
  for (const block of system) {
    if (isObject(block) && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks
}

function normalizeMessages(messages: unknown): Ant.Message[] {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => ({
    role: isObject(message) && typeof message.role === 'string' ? message.role : 'user',
    content: normalizeContent(isObject(message) ? message.content : undefined),
  }))
}

// string -> one text block; array -> valid blocks only; anything else -> [].
function normalizeContent(content: unknown): Ant.ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(
    (block) => isObject(block) && typeof block.type === 'string',
  ) as Ant.ContentBlock[]
}

/**
 * Flatten a tool_result's `content` to a string. An all-text array is concatenated
 * (the clean common case); anything with non-text blocks (images, structured
 * payloads) or a bare object is preserved as JSON rather than dropped, so nothing
 * the model needs is silently lost.
 */
export function toolResultText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (typeof block === 'string') text += block
      else if (isObject(block) && typeof block.text === 'string') text += block.text
      else return JSON.stringify(content)
    }
    return text
  }
  return JSON.stringify(content)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
