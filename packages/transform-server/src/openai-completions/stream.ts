import { genId } from '../anthropic'
import { mapFinishReason, mapUsage } from './response'
import type { OAI } from './types'

// Bridges an OpenAI Chat Completions SSE stream to Anthropic's streaming
// Messages events. `consume` frames the raw `data:` lines; the rest turns
// OpenAI's flat deltas into Anthropic's indexed, explicitly opened-and-closed
// content blocks. OpenAI has no "block start/stop", so transitions are
// inferred: a text/thinking block stays open until a different kind of delta
// (or the finish) forces it closed. Blocks never interleave, and `nextIndex`
// hands out a fresh, monotonically increasing index per block.
export class StreamTransformer {
  private nextIndex = 0
  private textBlock: number | null = null
  private thinkingBlock: number | null = null
  private readonly toolBlocks = new Map<number, number>() // OpenAI tool index -> Anthropic block index
  private started = false
  private stopSent = false

  constructor(
    private readonly model: string,
    private readonly emit: (chunk: string) => void,
    private readonly messageId: string = genId('msg'),
  ) {}

  // Consume the OpenAI SSE body to EOF, emitting Anthropic events as it goes and
  // flushing whatever is still open. Lines are `data: {json}`, ending on
  // `data: [DONE]`; partial lines are buffered and malformed ones skipped.
  async consume(body: ReadableStream<Uint8Array> | null) {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of body ?? []) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            this.push(JSON.parse(data))
          } catch {
            // Ignore malformed/partial chunks; the next line resyncs.
          }
        }
      }
    } finally {
      this.end()
    }
  }

  private start() {
    if (this.started) return
    this.started = true
    this.emit(
      sseEvent('message_start', {
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    )
  }

  // Feed one decoded OpenAI `chat.completion.chunk`.
  private push(chunk: OAI.StreamChunk) {
    this.start()
    const choice = chunk.choices?.[0]

    // Trailing usage-only chunk (choices:[] with a top-level usage object).
    if (!choice) {
      if (chunk.usage) this.handleUsageTail(chunk.usage)
      return
    }

    const delta = choice.delta ?? {}
    if (delta.reasoning_content) this.handleReasoning(delta.reasoning_content)
    if (delta.content) this.handleText(delta.content)
    if (delta.tool_calls?.length) {
      for (const call of delta.tool_calls) this.handleToolCall(call)
    }

    if (choice.finish_reason) {
      this.closeOpenBlocks()
      this.emit(
        sseEvent('message_delta', {
          delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
          usage: streamUsage(chunk.usage),
        }),
      )
      this.stopSent = true
    }
  }

  // Flush any still-open blocks and close out the message at EOF.
  private end() {
    this.start()
    const hadTools = this.toolBlocks.size > 0
    this.closeOpenBlocks()
    if (!this.stopSent) {
      this.emit(
        sseEvent('message_delta', {
          delta: { stop_reason: hadTools ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: streamUsage(undefined),
        }),
      )
      this.stopSent = true
    }
    this.emit(sseEvent('message_stop', {}))
  }

  private handleReasoning(text: string) {
    this.closeText()
    if (this.thinkingBlock === null) {
      this.thinkingBlock = this.nextIndex++
      this.emit(
        sseEvent('content_block_start', { index: this.thinkingBlock, content_block: { type: 'thinking', thinking: '', signature: '' } }),
      )
    }
    this.emit(sseEvent('content_block_delta', { index: this.thinkingBlock, delta: { type: 'thinking_delta', thinking: text } }))
  }

  private handleText(text: string) {
    this.closeThinking()
    if (this.textBlock === null) {
      this.textBlock = this.nextIndex++
      this.emit(sseEvent('content_block_start', { index: this.textBlock, content_block: { type: 'text', text: '' } }))
    }
    this.emit(sseEvent('content_block_delta', { index: this.textBlock, delta: { type: 'text_delta', text } }))
  }

  private handleToolCall(call: OAI.StreamToolCall) {
    let index = this.toolBlocks.get(call.index)
    // The first chunk for a tool carries its id + name; open the block then.
    if (index === undefined && call.function?.name) {
      this.closeText()
      this.closeThinking()
      index = this.nextIndex++
      this.toolBlocks.set(call.index, index)
      this.emit(
        sseEvent('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: call.id || genId('toolu'), name: call.function.name, input: {} },
        }),
      )
    }
    // Subsequent chunks carry argument fragments.
    if (index !== undefined && call.function?.arguments) {
      this.emit(sseEvent('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } }))
    }
  }

  private handleUsageTail(usage: OAI.Usage) {
    if (this.stopSent) {
      this.emit(sseEvent('message_delta', { delta: {}, usage: streamUsage(usage) }))
      return
    }
    this.closeOpenBlocks()
    this.emit(sseEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: streamUsage(usage) }))
    this.stopSent = true
  }

  private closeText() {
    if (this.textBlock !== null) {
      this.emit(sseEvent('content_block_stop', { index: this.textBlock }))
      this.textBlock = null
    }
  }

  private closeThinking() {
    if (this.thinkingBlock !== null) {
      this.emit(sseEvent('content_block_stop', { index: this.thinkingBlock }))
      this.thinkingBlock = null
    }
  }

  private closeOpenBlocks() {
    this.closeText()
    this.closeThinking()
    for (const index of [...this.toolBlocks.values()].sort((a, b) => a - b)) {
      this.emit(sseEvent('content_block_stop', { index }))
    }
    this.toolBlocks.clear()
  }
}

/** Serialize one Anthropic SSE event. The payload always echoes its `type`. */
function sseEvent(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

function streamUsage(usage: OAI.Usage | undefined) {
  const mapped = mapUsage(usage)
  return {
    input_tokens: mapped.input_tokens,
    output_tokens: mapped.output_tokens,
    cache_read_input_tokens: mapped.cache_read_input_tokens,
    cache_creation_input_tokens: mapped.cache_creation_input_tokens,
  }
}
