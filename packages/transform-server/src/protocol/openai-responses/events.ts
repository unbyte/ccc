import type { JsonValue } from '../json'
import type { OpenAIOutputText, OpenAIReasoningTextPart } from './common'
import type { OpenAIResponse, OpenAIResponseOutputItem } from './response'

interface OpenAISequencedEvent {
  /** Monotonic upstream sequence number when supplied. */
  sequence_number?: number
}

/** Strongly typed Responses streaming events consumed by the transformer. */
export type OpenAIKnownResponseEvent =
  | (OpenAISequencedEvent & { type: 'response.created'; response: OpenAIResponse })
  | (OpenAISequencedEvent & {
      type: 'response.output_item.added' | 'response.output_item.done'
      output_index: number
      item: OpenAIResponseOutputItem
    })
  | (OpenAISequencedEvent & {
      type: 'response.content_part.added' | 'response.content_part.done'
      item_id: string
      output_index: number
      content_index: number
      part: OpenAIOutputText
    })
  | (OpenAISequencedEvent & {
      type: 'response.output_text.delta'
      item_id: string
      output_index: number
      content_index: number
      delta: string
    })
  | (OpenAISequencedEvent & {
      type: 'response.output_text.done'
      item_id: string
      output_index: number
      content_index: number
      text: string
    })
  | (OpenAISequencedEvent & {
      type: 'response.function_call_arguments.delta'
      item_id?: string
      output_index?: number
      call_id?: string
      delta: string
    })
  | (OpenAISequencedEvent & {
      type: 'response.function_call_arguments.done'
      item_id?: string
      output_index?: number
      call_id?: string
      arguments: string
    })
  | (OpenAISequencedEvent & {
      type: 'response.reasoning_summary_part.added' | 'response.reasoning_summary_part.done'
      item_id: string
      output_index: number
      summary_index: number
      part: OpenAIReasoningTextPart
    })
  | (OpenAISequencedEvent & {
      type: 'response.reasoning_summary_text.delta'
      item_id: string
      output_index: number
      summary_index: number
      delta: string
    })
  | (OpenAISequencedEvent & {
      type:
        | 'response.web_search_call.in_progress'
        | 'response.web_search_call.searching'
        | 'response.web_search_call.completed'
      item_id?: string
      output_index?: number
    })
  | (OpenAISequencedEvent & {
      type: 'response.completed' | 'response.incomplete' | 'response.failed'
      response: OpenAIResponse
    })
  | (OpenAISequencedEvent & {
      type: 'error'
      error: { type?: string; code?: string; message?: string }
      error_type?: string
      message?: string
    })

/** Forward-compatible wrapper for an unrecognized decoded Responses event. */
export interface OpenAIUnknownResponseEvent {
  /** Ensures unknown events cannot overlap known discriminators. */
  type: 'unknown'
  /** Original upstream event type. */
  upstreamType: string
  /** Complete decoded JSON payload. */
  raw: Record<string, JsonValue>
}

/** Any decoded Responses event accepted by the state machine. */
export type OpenAIResponseEvent = OpenAIKnownResponseEvent | OpenAIUnknownResponseEvent
