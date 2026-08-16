import { isJsonObject, type JsonValue } from '../../protocol/json'
import type { OpenAIKnownResponseEvent, OpenAIResponseEvent } from '../../protocol/openai-responses'

const knownEventTypes = new Set<OpenAIKnownResponseEvent['type']>([
  'error',
  'response.created',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_part.done',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.completed',
  'response.incomplete',
  'response.failed',
])

/** Decodes one parsed SSE data value into a known event or forward-compatible wrapper. */
export function decodeOpenAIResponseEvent(data: string): OpenAIResponseEvent {
  let decoded: unknown
  try {
    decoded = JSON.parse(data)
  } catch (error) {
    throw new Error(`Malformed Responses event JSON: ${(error as Error).message}`)
  }
  if (!isJsonObject(decoded) || typeof decoded.type !== 'string') {
    throw new Error('Responses event must be an object with a string type')
  }
  if (knownEventTypes.has(decoded.type as OpenAIKnownResponseEvent['type'])) {
    return decoded as unknown as OpenAIKnownResponseEvent
  }
  return {
    type: 'unknown',
    upstreamType: decoded.type,
    raw: decoded as Record<string, JsonValue>,
  }
}
