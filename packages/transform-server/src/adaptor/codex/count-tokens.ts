import { Tiktoken } from 'js-tiktoken/lite'
import o200kBase from 'js-tiktoken/ranks/o200k_base'
import type { AnthropicMessageRequest } from '../../protocol/anthropic-messages'
import type {
  OpenAIResponseInputItem,
  OpenAIResponsesRequest,
} from '../../protocol/openai-responses'

let tokenizer: Tiktoken | undefined

function getTokenizer() {
  tokenizer ??= new Tiktoken(o200kBase)
  return tokenizer
}

function inputSegments(item: OpenAIResponseInputItem) {
  if (item.type === 'message') {
    return item.content.flatMap((part) => ('text' in part ? [part.text] : []))
  }
  if (item.type === 'function_call') return [item.name, item.arguments]
  if (item.type === 'function_call_output') {
    if (typeof item.output === 'string') return [item.output]
    return item.output.flatMap((part) => ('text' in part ? [part.text] : []))
  }
  return []
}

/** Collects the same translated text/schema segments used by compatibility token counting. */
export function tokenCountText(
  request: OpenAIResponsesRequest,
  original?: AnthropicMessageRequest,
) {
  const segments: string[] = []
  if (request.instructions) segments.push(request.instructions)
  for (const item of request.input) segments.push(...inputSegments(item))
  for (const tool of request.tools ?? []) {
    if (tool.type === 'function') {
      segments.push(tool.name)
      if (tool.description) segments.push(tool.description)
      segments.push(JSON.stringify(tool.parameters))
    } else {
      segments.push('web_search')
      if (tool.filters) segments.push(JSON.stringify(tool.filters))
      if (tool.user_location) segments.push(JSON.stringify(tool.user_location))
    }
  }
  const outputConfig = original?.output_config
  if (outputConfig && typeof outputConfig === 'object') {
    const format = outputConfig.format
    if (format && typeof format === 'object') segments.push(JSON.stringify(format))
  }
  return segments.join('\n')
}

/** Counts local o200k_base token IDs without network model lookup. */
export function countTokens(request: OpenAIResponsesRequest, original?: AnthropicMessageRequest) {
  return getTokenizer().encode(tokenCountText(request, original)).length
}
