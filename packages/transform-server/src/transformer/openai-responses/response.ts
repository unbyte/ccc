import type {
  AnthropicErrorType,
  AnthropicMessageResponse,
  AnthropicMessageStreamEvent,
  AnthropicStopReason,
  AnthropicUsage,
} from '../../protocol/anthropic-messages'
import type {
  OpenAIFunctionCallOutputItem,
  OpenAIResponse,
  OpenAIResponseEvent,
  OpenAIResponseOutputItem,
  OpenAIWebSearchOutputItem,
} from '../../protocol/openai-responses'
import { StreamResponder } from '../stream-responder'
import { restoreCallId, restoreToolName, sanitizeAnthropicToolId } from './identifiers'
import type { ResponseTransformContext } from './types'

const summarySeparator = '\n\n'

/** Error raised for a malformed or truncated upstream response lifecycle. */
export class ResponseTransformError extends Error {}

interface FunctionCallState {
  aliases: Set<string>
  callId: string
  name: string
  arguments: string
  emittedLength: number
  blockIndex?: number
  receivedDelta: boolean
  emitEmptyDelta: boolean
  started: boolean
  done: boolean
  closed: boolean
}

function responseUsage(response: OpenAIResponse): AnthropicUsage {
  const cached = Math.max(0, response.usage?.input_tokens_details?.cached_tokens ?? 0)
  const input = Math.max(0, (response.usage?.input_tokens ?? 0) - cached)
  return {
    input_tokens: input,
    output_tokens: Math.max(0, response.usage?.output_tokens ?? 0),
    cache_read_input_tokens: cached > 0 ? cached : undefined,
  }
}

function stopReason(response: OpenAIResponse, hasToolUse: boolean): AnthropicStopReason {
  if (hasToolUse) return 'tool_use'
  let reason = response.stop_reason || response.incomplete_details?.reason || ''
  if (reason === 'stop' && response.stop_sequence) reason = 'stop_sequence'
  if (!reason && response.stop_sequence) reason = 'stop_sequence'
  if (!reason || reason === 'stop' || reason === 'completed') return 'end_turn'
  if (reason === 'max_tokens' || reason === 'max_output_tokens') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  if (['tool_use', 'tool_calls', 'function_call'].includes(reason)) return 'end_turn'
  if (
    [
      'end_turn',
      'stop_sequence',
      'pause_turn',
      'refusal',
      'model_context_window_exceeded',
    ].includes(reason)
  ) {
    return reason as AnthropicStopReason
  }
  return 'end_turn'
}

function eventCallAliases(
  event: {
    output_index?: number
    item_id?: string
    call_id?: string
  },
  item?: Partial<OpenAIFunctionCallOutputItem>,
) {
  const aliases: string[] = []
  if (event.output_index !== undefined) aliases.push(`output:${event.output_index}`)
  const callId = item?.call_id || event.call_id
  if (callId) aliases.push(`call:${callId}`)
  const itemId = item?.id || event.item_id
  if (itemId) aliases.push(`item:${itemId}`)
  return aliases
}

function parseToolInput(argumentsValue: string) {
  try {
    const value: unknown = JSON.parse(argumentsValue)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function webSearchQuery(item: OpenAIWebSearchOutputItem) {
  return item.action?.query?.trim() || item.query?.trim() || ''
}

/** Stateful Responses-event to Anthropic Messages-event transformer. */
export class OpenAIResponseTransformer extends StreamResponder<OpenAIResponseEvent> {
  private created = false
  private terminal = false
  private nextBlockIndex = 0
  private openTextIndex?: number
  private openThinkingIndex?: number
  private hasTextDelta = false
  private thinkingSignature = ''
  private thinkingSummarySeen = false
  private thinkingPartCount = 0
  private hasToolUse = false
  private outputItems = new Map<number, OpenAIResponseOutputItem>()
  private processedOutputItems = new Set<number>()
  private callsByAlias = new Map<string, FunctionCallState>()
  private callQueue: FunctionCallState[] = []
  private activeCall?: FunctionCallState
  private lastCall?: FunctionCallState
  private deferred: OpenAIResponseEvent[] = []
  private drainingDeferred = false
  private webSearchIds = new Set<string>()

  constructor(private readonly context: ResponseTransformContext) {
    super()
  }

  protected async process(event: OpenAIResponseEvent) {
    if (this.terminal) throw new ResponseTransformError('Received an event after terminal response')
    if (event.type === 'unknown') return

    if (this.shouldDefer(event)) {
      this.deferred.push(event)
      return
    }

    switch (event.type) {
      case 'response.created':
        await this.startMessage(event.response)
        return
      case 'response.output_item.added':
        await this.onOutputItemAdded(event)
        return
      case 'response.output_item.done':
        this.outputItems.set(event.output_index, event.item)
        await this.onOutputItemDone(event.output_index, event.item)
        return
      case 'response.content_part.added':
        if (event.part.type === 'output_text') {
          await this.finishThinkingBlock()
          await this.startTextBlock()
        }
        return
      case 'response.output_text.delta':
        this.hasTextDelta = true
        await this.finishThinkingBlock()
        await this.startTextBlock()
        await this.emit({
          type: 'content_block_delta',
          index: this.openTextIndex as number,
          delta: { type: 'text_delta', text: event.delta },
        })
        return
      case 'response.output_text.done':
        return
      case 'response.content_part.done':
        if (event.part.type === 'output_text') await this.stopTextBlock()
        return
      case 'response.function_call_arguments.delta': {
        const call = this.findOrCreateCall(event)
        call.arguments += event.delta
        call.receivedDelta = true
        await this.emitBufferedArguments(call)
        return
      }
      case 'response.function_call_arguments.done': {
        const call = this.findOrCreateCall(event)
        if (!call.receivedDelta || event.arguments.startsWith(call.arguments)) {
          call.arguments = event.arguments
        }
        await this.emitBufferedArguments(call)
        return
      }
      case 'response.reasoning_summary_part.added':
        await this.stopTextBlock()
        if (this.openThinkingIndex !== undefined && this.thinkingPartCount > 0) {
          await this.emitThinkingDelta(summarySeparator)
        } else {
          await this.startThinkingBlock()
        }
        this.thinkingPartCount += 1
        this.thinkingSummarySeen = true
        return
      case 'response.reasoning_summary_text.delta':
        await this.stopTextBlock()
        await this.startThinkingBlock()
        this.thinkingSummarySeen = true
        await this.emitThinkingDelta(event.delta)
        return
      case 'response.reasoning_summary_part.done':
      case 'response.web_search_call.in_progress':
      case 'response.web_search_call.searching':
      case 'response.web_search_call.completed':
        return
      case 'response.completed':
      case 'response.incomplete':
        await this.onTerminal(event.response)
        return
      case 'response.failed':
        await this.onFailed(event.response)
        return
      case 'error':
        await this.emitError(
          event.error.type || event.error_type || 'api_error',
          event.error.message || event.message || event.error.code || 'Upstream response error',
        )
        this.terminal = true
        return
    }
  }

  protected async complete() {
    if (!this.terminal)
      throw new ResponseTransformError('Upstream response ended without a terminal event')
  }

  private shouldDefer(event: Exclude<OpenAIResponseEvent, { type: 'unknown' }>) {
    if (this.activeCall === undefined || this.drainingDeferred) return false
    if (
      event.type === 'error' ||
      event.type === 'response.completed' ||
      event.type === 'response.incomplete' ||
      event.type === 'response.failed' ||
      event.type === 'response.function_call_arguments.delta' ||
      event.type === 'response.function_call_arguments.done'
    ) {
      return false
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      return event.item.type !== 'function_call'
    }
    return true
  }

  private async startMessage(response: OpenAIResponse) {
    if (this.created) return
    this.created = true
    await this.emit({
      type: 'message_start',
      message: {
        id: response.id,
        type: 'message',
        role: 'assistant',
        model: response.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  private async onOutputItemAdded(event: { output_index: number; item: OpenAIResponseOutputItem }) {
    const { item } = event
    if (item.type === 'function_call') {
      await this.finishThinkingBlock()
      await this.stopTextBlock()
      const call = this.findOrCreateCall(event, item)
      this.updateCall(call, item)
      if (call.name) call.emitEmptyDelta = true
      await this.pumpCalls()
      return
    }
    if (item.type === 'reasoning') {
      await this.stopTextBlock()
      await this.finishThinkingBlock()
      this.thinkingSummarySeen = false
      this.thinkingPartCount = 0
      this.thinkingSignature = item.encrypted_content ?? ''
    }
  }

  private async onOutputItemDone(index: number, item: OpenAIResponseOutputItem) {
    if (this.processedOutputItems.has(index)) return
    this.processedOutputItems.add(index)
    if (item.type === 'message') {
      if (this.hasTextDelta) return
      const text = item.content
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('')
      if (!text) return
      await this.finishThinkingBlock()
      await this.startTextBlock()
      this.hasTextDelta = true
      await this.emit({
        type: 'content_block_delta',
        index: this.openTextIndex as number,
        delta: { type: 'text_delta', text },
      })
      await this.stopTextBlock()
      return
    }
    if (item.type === 'function_call') {
      await this.finishThinkingBlock()
      await this.stopTextBlock()
      const call = this.findOrCreateCall({ output_index: index }, item)
      this.updateCall(call, item)
      if (!call.receivedDelta || item.arguments.startsWith(call.arguments)) {
        call.arguments = item.arguments
      }
      call.done = true
      await this.pumpCalls()
      await this.drainDeferred()
      return
    }
    if (item.type === 'reasoning') {
      await this.stopTextBlock()
      if (item.encrypted_content) this.thinkingSignature = item.encrypted_content
      if (!this.thinkingSummarySeen) {
        const fallback = (item.summary?.length ? item.summary : (item.content ?? []))
          .map((part) => part.text)
          .join('')
        if (fallback) {
          await this.startThinkingBlock()
          this.thinkingSummarySeen = true
          await this.emitThinkingDelta(fallback)
        }
      }
      if (this.thinkingSummarySeen) await this.finishThinkingBlock()
      else await this.finishSignatureOnlyThinkingBlock()
      this.thinkingSignature = ''
      this.thinkingSummarySeen = false
      this.thinkingPartCount = 0
      return
    }
    await this.emitWebSearch(item)
  }

  private findOrCreateCall(
    event: { output_index?: number; item_id?: string; call_id?: string },
    item?: Partial<OpenAIFunctionCallOutputItem>,
  ) {
    const aliases = eventCallAliases(event, item)
    let call = aliases.map((alias) => this.callsByAlias.get(alias)).find(Boolean)
    if (call === undefined && aliases.length === 0) call = this.lastCall
    if (call === undefined) {
      call = {
        aliases: new Set(),
        callId: '',
        name: '',
        arguments: '',
        emittedLength: 0,
        receivedDelta: false,
        emitEmptyDelta: false,
        started: false,
        done: false,
        closed: false,
      }
      this.callQueue.push(call)
    }
    for (const alias of aliases) {
      call.aliases.add(alias)
      this.callsByAlias.set(alias, call)
    }
    this.lastCall = call
    return call
  }

  private updateCall(call: FunctionCallState, item: Partial<OpenAIFunctionCallOutputItem>) {
    if (item.call_id) call.callId = item.call_id
    if (item.name) call.name = item.name
  }

  private async pumpCalls() {
    while (true) {
      if (this.activeCall !== undefined) {
        await this.emitBufferedArguments(this.activeCall)
        if (!this.activeCall.done) return
        const closing = this.activeCall
        await this.emit({ type: 'content_block_stop', index: closing.blockIndex as number })
        closing.closed = true
        this.activeCall = undefined
        this.callQueue = this.callQueue.filter((call) => call !== closing)
      }
      const next = this.callQueue.find((call) => !call.closed)
      if (next === undefined || !next.name) return
      next.blockIndex = this.nextBlockIndex
      this.nextBlockIndex += 1
      next.started = true
      this.activeCall = next
      this.hasToolUse = true
      await this.emit({
        type: 'content_block_start',
        index: next.blockIndex,
        content_block: {
          type: 'tool_use',
          id: restoreCallId(this.context.originalCallIds, next.callId),
          name: restoreToolName(this.context.originalToolNames, next.name),
          input: {},
        },
      })
      if (next.emitEmptyDelta) {
        await this.emit({
          type: 'content_block_delta',
          index: next.blockIndex,
          delta: { type: 'input_json_delta', partial_json: '' },
        })
      }
      await this.emitBufferedArguments(next)
    }
  }

  private async emitBufferedArguments(call: FunctionCallState) {
    if (this.activeCall !== call || call.blockIndex === undefined || call.closed) return
    if (call.emittedLength >= call.arguments.length) return
    const suffix = call.arguments.slice(call.emittedLength)
    call.emittedLength = call.arguments.length
    await this.emit({
      type: 'content_block_delta',
      index: call.blockIndex,
      delta: { type: 'input_json_delta', partial_json: suffix },
    })
  }

  private async hydrateTerminalCalls(output: OpenAIResponseOutputItem[]) {
    output.forEach((item, index) => {
      if (item.type !== 'function_call') return
      const aliases = eventCallAliases({ output_index: item.output_index ?? index }, item)
      const call = aliases.map((alias) => this.callsByAlias.get(alias)).find(Boolean)
      if (call === undefined) return
      this.updateCall(call, item)
      if (!call.receivedDelta || item.arguments.startsWith(call.arguments))
        call.arguments = item.arguments
      call.done = true
    })
    for (const call of this.callQueue) {
      if (!call.closed) call.done = true
    }
    await this.pumpCalls()
  }

  private async drainDeferred() {
    if (this.activeCall !== undefined || this.deferred.length === 0 || this.drainingDeferred) return
    const deferred = this.deferred
    this.deferred = []
    this.drainingDeferred = true
    try {
      for (const event of deferred) await this.process(event)
    } finally {
      this.drainingDeferred = false
    }
  }

  private async onTerminal(response: OpenAIResponse) {
    await this.startMessage(response)
    const outputEntries =
      response.output.length > 0
        ? response.output.map((item, index) => [index, item] as const)
        : [...this.outputItems.entries()].sort(([left], [right]) => left - right)
    const output = outputEntries.map(([, item]) => item)
    await this.hydrateTerminalCalls(output)
    await this.drainDeferred()
    for (const [index, item] of outputEntries) {
      if (!this.processedOutputItems.has(index)) await this.onOutputItemDone(index, item)
    }
    await this.finishThinkingBlock()
    await this.stopTextBlock()
    await this.pumpCalls()
    if (this.activeCall !== undefined) {
      this.activeCall.done = true
      await this.pumpCalls()
    }
    await this.emit({
      type: 'message_delta',
      delta: {
        stop_reason: stopReason(response, this.hasToolUse),
        stop_sequence: response.stop_sequence ?? null,
      },
      usage: responseUsage(response),
    })
    await this.emit({ type: 'message_stop' })
    this.terminal = true
  }

  private async onFailed(response: OpenAIResponse) {
    const error = response.error
    await this.emitError(
      error?.type || error?.code || 'api_error',
      error?.message || 'Upstream response failed',
    )
    this.terminal = true
  }

  private async emitError(type: string, message: string) {
    const anthropicType: AnthropicErrorType =
      type === 'invalid_request' || type === 'invalid_request_error' || type === 'cyber_policy'
        ? 'invalid_request_error'
        : 'api_error'
    await this.emit({ type: 'error', error: { type: anthropicType, message } })
  }

  private async startTextBlock() {
    if (this.openTextIndex !== undefined) return
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    this.openTextIndex = index
    await this.emit({
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
  }

  private async stopTextBlock() {
    if (this.openTextIndex === undefined) return
    const index = this.openTextIndex
    this.openTextIndex = undefined
    await this.emit({ type: 'content_block_stop', index })
  }

  private async startThinkingBlock() {
    if (this.openThinkingIndex !== undefined) return
    const index = this.nextBlockIndex
    this.nextBlockIndex += 1
    this.openThinkingIndex = index
    await this.emit({
      type: 'content_block_start',
      index,
      content_block: { type: 'thinking', thinking: '' },
    })
  }

  private async emitThinkingDelta(thinking: string) {
    await this.startThinkingBlock()
    await this.emit({
      type: 'content_block_delta',
      index: this.openThinkingIndex as number,
      delta: { type: 'thinking_delta', thinking },
    })
  }

  private async finishThinkingBlock() {
    if (this.openThinkingIndex === undefined) return
    const index = this.openThinkingIndex
    if (this.thinkingSignature) {
      await this.emit({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: this.thinkingSignature },
      })
    }
    this.openThinkingIndex = undefined
    await this.emit({ type: 'content_block_stop', index })
  }

  private async finishSignatureOnlyThinkingBlock() {
    if (!this.thinkingSignature) return
    await this.startThinkingBlock()
    await this.finishThinkingBlock()
  }

  private async emitWebSearch(item: OpenAIWebSearchOutputItem) {
    const id = item.id?.trim()
    if (!id || this.webSearchIds.has(id)) return
    const query = webSearchQuery(item)
    const results = (item.results ?? [])
      .filter((result) => result.url?.trim())
      .map((result) => ({
        type: 'web_search_result' as const,
        title: result.title?.trim() || result.url,
        url: result.url,
        page_age: null,
      }))
    if (!query && results.length === 0 && item.action === undefined) return
    await this.stopTextBlock()
    await this.finishThinkingBlock()
    const toolId = sanitizeAnthropicToolId(id)
    const useIndex = this.nextBlockIndex
    this.nextBlockIndex += 1
    await this.emit({
      type: 'content_block_start',
      index: useIndex,
      content_block: { type: 'server_tool_use', id: toolId, name: 'web_search', input: {} },
    })
    if (query) {
      await this.emit({
        type: 'content_block_delta',
        index: useIndex,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) },
      })
    }
    await this.emit({ type: 'content_block_stop', index: useIndex })
    const resultIndex = this.nextBlockIndex
    this.nextBlockIndex += 1
    await this.emit({
      type: 'content_block_start',
      index: resultIndex,
      content_block: { type: 'web_search_tool_result', tool_use_id: toolId, content: results },
    })
    await this.emit({ type: 'content_block_stop', index: resultIndex })
    this.webSearchIds.add(id)
  }
}

/** Converts one terminal Responses object without maintaining a second mapping implementation. */
export async function transformOpenAITerminalResponse(
  response: OpenAIResponse,
  context: ResponseTransformContext,
) {
  const transformer = new OpenAIResponseTransformer(context)
  const collector = new AnthropicMessageCollector()
  transformer.on((event) => collector.push(event))
  await transformer.push({ type: 'response.created', response: { ...response, output: [] } })
  await transformer.push({
    type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response,
  })
  await transformer.finish()
  return collector.result()
}

/** Collects transformed stream events into one non-streaming Anthropic message. */
export class AnthropicMessageCollector {
  private message?: AnthropicMessageResponse
  private blocks = new Map<
    number,
    { block: AnthropicMessageResponse['content'][number]; data: string }
  >()
  private stopped = false

  push(event: AnthropicMessageStreamEvent) {
    switch (event.type) {
      case 'message_start':
        this.message = structuredClone(event.message)
        return
      case 'content_block_start':
        this.blocks.set(event.index, { block: structuredClone(event.content_block), data: '' })
        return
      case 'content_block_delta': {
        const current = this.blocks.get(event.index)
        if (current === undefined)
          throw new ResponseTransformError('Delta received for an unknown block')
        if (event.delta.type === 'text_delta' && current.block.type === 'text') {
          current.block.text += event.delta.text
        } else if (event.delta.type === 'thinking_delta' && current.block.type === 'thinking') {
          current.block.thinking += event.delta.thinking
        } else if (event.delta.type === 'signature_delta' && current.block.type === 'thinking') {
          current.block.signature = event.delta.signature
        } else if (event.delta.type === 'input_json_delta') {
          current.data += event.delta.partial_json
        }
        return
      }
      case 'content_block_stop': {
        const current = this.blocks.get(event.index)
        if (current === undefined || this.message === undefined) {
          throw new ResponseTransformError('Stop received for an unknown block')
        }
        if (current.block.type === 'tool_use' || current.block.type === 'server_tool_use') {
          current.block.input = parseToolInput(current.data)
        }
        this.message.content.push(current.block)
        this.blocks.delete(event.index)
        return
      }
      case 'message_delta':
        if (this.message === undefined)
          throw new ResponseTransformError('Message delta arrived before start')
        this.message.stop_reason = event.delta.stop_reason
        this.message.stop_sequence = event.delta.stop_sequence
        this.message.usage = event.usage
        return
      case 'message_stop':
        this.stopped = true
        return
      case 'error':
        throw new ResponseTransformError(event.error.message)
    }
  }

  result() {
    if (!this.stopped || this.message === undefined || this.blocks.size > 0) {
      throw new ResponseTransformError('Cannot collect an incomplete Anthropic message')
    }
    return this.message
  }
}
