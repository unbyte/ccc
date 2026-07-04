import type { Ant } from '../anthropic'
import { genId } from '../anthropic'
import { mapFinishReason, mapUsage } from './response'
import type { OAI } from './types'

interface ToolBlock {
  openaiIndex: number
  anthropicIndex: number
  id: string
  name: string
  started: boolean
  pendingArgs: string
}

// Bridges an OpenAI Chat Completions SSE stream to Anthropic's streaming Messages
// events. OpenAI has no block start/stop, so transitions are inferred: a
// text/thinking block stays open until a different kind of delta forces it closed,
// and each block gets a fresh, monotonically increasing index.
//
// Two properties matter for Claude Code compatibility:
//   * Exactly one `message_delta` is emitted. Providers may send several
//     finish_reason chunks (usage trails after choices go empty); the stop reason
//     and the most complete usage are buffered and flushed once, at the end.
//   * A stream that ends in error emits an `error` event and never fabricates the
//     `message_delta`/`message_stop` that would signal a clean completion.
export class StreamTransformer {
  private nextIndex = 0
  private started = false
  private stopSent = false
  private erroredOut = false
  private sawTools = false

  // The single open non-tool block (text or thinking).
  private blockType: 'text' | 'thinking' | null = null
  private blockIndex: number | null = null

  private readonly toolBlocks = new Map<number, ToolBlock>() // OpenAI tool index -> state
  private readonly openToolIndices = new Set<number>()

  // Buffered terminal message_delta.
  private finishSeen = false
  private stopReason: string | null = null
  private usage: Ant.Usage | null = null

  constructor(
    private readonly model: string,
    private readonly emit: (chunk: string) => void,
    private readonly messageId: string = genId('msg'),
  ) {}

  // Consume the OpenAI SSE body to EOF. Lines are `data: {json}`, ending on
  // `data: [DONE]`; partial lines are buffered and malformed ones skipped. A
  // transport error aborts with an `error` event; a clean EOF flushes the terminal.
  async consume(body: ReadableStream<Uint8Array> | null) {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of body ?? []) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          this.line(buffer.slice(0, nl).trim())
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
        }
      }
    } catch (error) {
      this.fail(error)
      return
    }
    this.flushTerminal()
  }

  private line(line: string) {
    if (this.stopSent || !line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      this.flushTerminal()
      return
    }
    try {
      this.push(JSON.parse(data) as OAI.StreamChunk)
    } catch {
      // Ignore malformed/partial chunks; the next line resyncs.
    }
  }

  // Feed one decoded OpenAI `chat.completion.chunk`.
  private push(chunk: OAI.StreamChunk) {
    this.start(chunk)

    // Latest usage wins; the tail chunk (choices: []) carries the complete counts.
    if (chunk.usage) this.usage = mapUsage(chunk.usage)

    const choice = chunk.choices?.[0]
    if (!choice) return // usage-only tail chunk (choices: [])

    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning ?? delta.reasoning_content
    if (reasoning) this.handleReasoning(reasoning)
    if (delta.content) this.handleText(delta.content)
    for (const call of delta.tool_calls ?? []) this.handleToolCall(call)

    if (choice.finish_reason) this.handleFinish(choice.finish_reason)
  }

  private start(chunk?: OAI.StreamChunk) {
    if (this.started) return
    this.started = true
    const usage = chunk?.usage ? mapUsage(chunk.usage) : { input_tokens: 0, output_tokens: 0 }
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
          usage,
        },
      }),
    )
  }

  private handleReasoning(text: string) {
    this.openBlock('thinking')
    this.emit(
      sseEvent('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'thinking_delta', thinking: text },
      }),
    )
  }

  private handleText(text: string) {
    if (!text) return
    this.openBlock('text')
    this.emit(
      sseEvent('content_block_delta', {
        index: this.blockIndex,
        delta: { type: 'text_delta', text },
      }),
    )
  }

  private openBlock(type: 'text' | 'thinking') {
    if (this.blockType === type) return
    this.closeBlock()
    const index = this.nextIndex++
    this.blockType = type
    this.blockIndex = index
    const contentBlock =
      type === 'thinking' ? { type, thinking: '', signature: '' } : { type, text: '' }
    this.emit(sseEvent('content_block_start', { index, content_block: contentBlock }))
  }

  private handleToolCall(call: OAI.StreamToolCall) {
    this.closeBlock() // tool calls close any open text/thinking block
    let state = this.toolBlocks.get(call.index)
    if (!state) {
      state = {
        openaiIndex: call.index,
        anthropicIndex: this.nextIndex++,
        id: '',
        name: '',
        started: false,
        pendingArgs: '',
      }
      this.toolBlocks.set(call.index, state)
      this.sawTools = true
    }
    if (call.id) state.id = call.id
    if (call.function?.name) state.name = call.function.name

    // Start only once both id and name are known; buffer arg fragments until then.
    if (!state.started && state.id && state.name) {
      this.startTool(state)
    }
    const args = call.function?.arguments
    if (args) {
      if (state.started) this.emitToolArgs(state.anthropicIndex, args)
      else state.pendingArgs += args
    }
  }

  private startTool(state: ToolBlock) {
    state.started = true
    this.openToolIndices.add(state.anthropicIndex)
    this.emit(
      sseEvent('content_block_start', {
        index: state.anthropicIndex,
        content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
      }),
    )
    if (state.pendingArgs) {
      this.emitToolArgs(state.anthropicIndex, state.pendingArgs)
      state.pendingArgs = ''
    }
  }

  private emitToolArgs(index: number, partial: string) {
    this.emit(
      sseEvent('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: partial },
      }),
    )
  }

  private handleFinish(finishReason: string) {
    if (this.finishSeen) return // dedup extra finish chunks; usage already tracked via push()
    this.finishSeen = true
    this.stopReason = mapFinishReason(finishReason) ?? 'end_turn'
    this.closeAllBlocks()
  }

  // Flush the single buffered message_delta and close the message. Called on
  // `[DONE]` and on a clean EOF; a no-op after an error or a prior flush.
  private flushTerminal() {
    if (this.erroredOut || this.stopSent) return
    this.start()
    if (!this.finishSeen) this.closeAllBlocks()
    const stopReason = this.stopReason ?? (this.sawTools ? 'tool_use' : 'end_turn')
    this.emit(
      sseEvent('message_delta', {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.usage ?? { input_tokens: 0, output_tokens: 0 },
      }),
    )
    this.emit(sseEvent('message_stop', {}))
    this.stopSent = true
  }

  private fail(error: unknown) {
    if (this.stopSent) return
    this.erroredOut = true
    this.stopSent = true
    this.emit(
      sseEvent('error', {
        error: { type: 'stream_error', message: `Stream error: ${errorMessage(error)}` },
      }),
    )
  }

  private closeBlock() {
    if (this.blockIndex !== null) {
      this.emit(sseEvent('content_block_stop', { index: this.blockIndex }))
      this.blockType = null
      this.blockIndex = null
    }
  }

  private closeAllBlocks() {
    this.closeBlock()
    // Late-start any tool that accumulated args before its id/name arrived.
    const late = [...this.toolBlocks.values()].filter(
      (s) => !s.started && (s.pendingArgs || s.id || s.name),
    )
    for (const state of late.sort((a, b) => a.anthropicIndex - b.anthropicIndex)) {
      if (!state.id) state.id = `tool_call_${state.openaiIndex}`
      if (!state.name) state.name = 'unknown_tool'
      this.startTool(state)
    }
    for (const index of [...this.openToolIndices].sort((a, b) => a - b)) {
      this.emit(sseEvent('content_block_stop', { index }))
    }
    this.openToolIndices.clear()
  }
}

/** Serialize one Anthropic SSE event. The payload always echoes its `type`. */
function sseEvent(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
