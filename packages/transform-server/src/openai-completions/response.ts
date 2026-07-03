import type { Ant } from '../anthropic'
import { genId, parseArguments } from '../anthropic'
import type { OAI } from './types'

/** OpenAI Chat Completions response -> Anthropic Messages response (non-streaming). */
export function transformResponse(resp: OAI.Response, model: string): Ant.Response {
  const choice = resp.choices?.[0]
  const message = choice?.message
  const content: Ant.ContentBlock[] = []

  // Order matters: thinking, then tool_use, then text.
  if (message?.reasoning_content) {
    content.push({ type: 'thinking', thinking: message.reasoning_content, signature: '' })
  }
  for (const call of message?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: call.id || genId('toolu'),
      name: call.function?.name ?? '',
      input: parseArguments(call.function?.arguments),
    })
  }
  const text = typeof message?.content === 'string' ? message.content : ''
  if (text) content.push({ type: 'text', text })

  // Claude Code expects at least one block.
  if (content.length === 0) content.push({ type: 'text', text: '' })

  return {
    id: resp.id || genId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(resp.usage),
  }
}

export function mapFinishReason(reason: string | null | undefined) {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'tool_use':
      return 'tool_use'
    default:
      // stop, content_filter and anything unknown map to end_turn.
      return 'end_turn'
  }
}

// Subtract cached tokens out of input_tokens so Claude Code's context meter
// counts each token once (input + cache_read + cache_creation == prompt_tokens)
// instead of over-counting and auto-compacting far too early.
export function mapUsage(usage: OAI.Usage | undefined): Ant.Usage {
  const prompt = usage?.prompt_tokens ?? 0
  const cacheRead = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  return {
    input_tokens: Math.max(0, prompt - cacheRead),
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  }
}
