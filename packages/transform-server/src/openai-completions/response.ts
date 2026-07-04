import { type Ant, genId } from '../anthropic-message'
import type { OAI } from './types'

// OpenAI Chat Completions response -> Anthropic Messages response (non-streaming).
// One-shot: build a transformer around the response and call `transform()` once.
export class ResponseTransformer {
  private readonly content: Ant.ContentBlock[] = []

  constructor(
    private readonly resp: OAI.Response,
    private readonly model: string,
  ) {}

  transform(): Ant.Response {
    const choice = this.resp.choices?.[0]
    const message = choice?.message

    // Order mirrors Claude's own output: thinking, then text, then tool_use.
    this.appendThinking(message)
    this.appendText(message)
    const hadToolUse = this.appendToolUse(message)

    // Claude Code expects at least one block.
    if (this.content.length === 0) this.content.push({ type: 'text', text: '' })

    return {
      id: this.resp.id || genId('msg'),
      type: 'message',
      role: 'assistant',
      model: this.model,
      content: this.content,
      stop_reason: mapFinishReason(choice?.finish_reason) ?? (hadToolUse ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: mapUsage(this.resp.usage),
    }
  }

  private appendThinking(message: OAI.ResponseMessage | undefined) {
    if (message?.reasoning_content) {
      this.content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' })
    }
  }

  // Text can arrive as a plain string, as content parts (text/output_text/refusal),
  // or as a message-level refusal; collect every non-empty piece.
  private appendText(message: OAI.ResponseMessage | undefined) {
    const content = message?.content
    if (typeof content === 'string') {
      if (content) this.content.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if ((part.type === 'text' || part.type === 'output_text') && part.text)
          this.content.push({ type: 'text', text: part.text })
        else if (part.type === 'refusal' && part.refusal)
          this.content.push({ type: 'text', text: part.refusal })
      }
    }
    if (message?.refusal) this.content.push({ type: 'text', text: message.refusal })
  }

  // Returns whether any tool_use block was produced. Falls back to the legacy
  // single-call `function_call` shape only when there were no modern tool_calls.
  private appendToolUse(message: OAI.ResponseMessage | undefined) {
    const before = this.content.length
    for (const call of message?.tool_calls ?? []) {
      this.content.push({
        type: 'tool_use',
        id: call.id || genId('toolu'),
        name: call.function?.name ?? '',
        input: parseArguments(call.function?.arguments),
      })
    }
    const legacy = message?.function_call
    if (
      this.content.length === before &&
      legacy &&
      (legacy.name || legacy.arguments !== undefined)
    ) {
      this.content.push({
        type: 'tool_use',
        id: legacy.id || genId('toolu'),
        name: legacy.name ?? '',
        input:
          typeof legacy.arguments === 'string'
            ? parseArguments(legacy.arguments)
            : (legacy.arguments ?? {}),
      })
    }
    return this.content.length > before
  }
}

export function mapFinishReason(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_use'
    case 'stop':
    case 'content_filter':
      return 'end_turn'
    default:
      // Absent finish_reason leaves the decision to the caller.
      return reason == null ? undefined : 'end_turn'
  }
}

// OpenAI's prompt_tokens is inclusive of cache hits; Anthropic's input_tokens is
// not. Subtract cache_read + cache_creation so each token is counted once
// (input + cache_read + cache_creation == prompt_tokens) instead of over-counting
// and making Claude Code auto-compact far too early.
export function mapUsage(usage: OAI.Usage | undefined): Ant.Usage {
  const prompt = usage?.prompt_tokens ?? 0
  const cacheRead =
    usage?.cache_read_input_tokens ??
    usage?.prompt_cache_hit_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0
  return {
    input_tokens: Math.max(0, prompt - cacheRead - cacheCreation),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  }
}

// OpenAI `tool_calls.function.arguments` (JSON string) -> Anthropic `tool_use.input`.
// `unknown` (not the `any` JSON.parse yields) so callers must narrow before use.
function parseArguments(args: string | undefined): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    return {}
  }
}
