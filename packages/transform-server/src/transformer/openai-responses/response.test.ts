import { describe, expect, it } from 'vitest'
import type { AnthropicMessageStreamEvent } from '../../protocol/anthropic-messages'
import { AnthropicMessageRole } from '../../protocol/anthropic-messages'
import type { OpenAIResponse } from '../../protocol/openai-responses'
import { transformAnthropicRequest } from './request'
import {
  AnthropicMessageCollector,
  OpenAIResponseTransformer,
  ResponseTransformError,
  transformOpenAITerminalResponse,
} from './response'

function response(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: 'resp_1',
    model: 'gpt-5.4',
    status: 'completed',
    output: [],
    usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
    ...overrides,
  }
}

function context(toolName = 'Read') {
  return transformAnthropicRequest({
    model: 'gpt-5.4',
    max_tokens: 100,
    messages: [{ role: AnthropicMessageRole.User, content: 'hello' }],
    tools: [{ name: toolName, input_schema: { type: 'object', properties: {} } }],
  }).context
}

async function collect(
  run: (transformer: OpenAIResponseTransformer) => Promise<void>,
  toolName = 'Read',
) {
  const transformer = new OpenAIResponseTransformer(context(toolName))
  const events: AnthropicMessageStreamEvent[] = []
  transformer.on((event) => {
    events.push(event)
  })
  await run(transformer)
  await transformer.finish()
  return events
}

function assertBlockLifecycle(events: AnthropicMessageStreamEvent[]) {
  const open = new Set<number>()
  for (const event of events) {
    if (event.type === 'content_block_start') {
      expect(open.has(event.index)).toBe(false)
      open.add(event.index)
    }
    if (event.type === 'content_block_delta') expect(open.has(event.index)).toBe(true)
    if (event.type === 'content_block_stop') {
      expect(open.has(event.index)).toBe(true)
      open.delete(event.index)
    }
    if (event.type === 'message_stop') expect(open.size).toBe(0)
  }
  expect(open.size).toBe(0)
}

describe('terminal response transformation', () => {
  it('collects text, thinking, restored tools, usage, and tool-use stop precedence', async () => {
    const longName = `mcp__server__${'very_long_name_'.repeat(6)}`
    const transformedContext = context(longName)
    const shortName = transformedContext.toolNames.get(longName) as string
    const result = await transformOpenAITerminalResponse(
      response({
        stop_reason: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: [
              { type: 'summary_text', text: 'first' },
              { type: 'summary_text', text: ' second' },
            ],
            encrypted_content: 'encrypted',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'answer' }],
          },
          {
            type: 'function_call',
            call_id: 'call:unsafe',
            name: shortName,
            arguments: '[]',
          },
        ],
      }),
      transformedContext,
    )

    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'first second', signature: 'encrypted' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call_unsafe', name: longName, input: {} },
    ])
    expect(result.stop_reason).toBe('tool_use')
    expect(result.usage).toEqual({
      input_tokens: 6,
      output_tokens: 3,
      cache_read_input_tokens: 4,
    })
  })

  it('maps incomplete reasons and floors cached input subtraction', async () => {
    const result = await transformOpenAITerminalResponse(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 2, output_tokens: 9, input_tokens_details: { cached_tokens: 5 } },
      }),
      context(),
    )
    expect(result.stop_reason).toBe('max_tokens')
    expect(result.usage).toEqual({
      input_tokens: 0,
      output_tokens: 9,
      cache_read_input_tokens: 5,
    })
  })
})

describe('OpenAIResponseTransformer streaming state machine', () => {
  it('serializes interleaved parallel calls and defers unrelated text', async () => {
    const events = await collect(async (transformer) => {
      await transformer.push({ type: 'response.created', response: response() })
      await transformer.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'item_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'Read',
          arguments: '',
        },
      })
      await transformer.push({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: 'item_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'Read',
          arguments: '',
        },
      })
      await transformer.push({
        type: 'response.output_text.delta',
        item_id: 'message_1',
        output_index: 2,
        content_index: 0,
        delta: 'after tools',
      })
      await transformer.push({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_2',
        output_index: 1,
        delta: '{"second":true}',
      })
      await transformer.push({
        type: 'response.function_call_arguments.delta',
        item_id: 'item_1',
        output_index: 0,
        delta: '{"first":true}',
      })
      await transformer.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'item_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'Read',
          arguments: '{"first":true}',
        },
      })
      await transformer.push({
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'item_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'Read',
          arguments: '{"second":true}',
        },
      })
      await transformer.push({
        type: 'response.completed',
        response: response({
          output: [
            {
              id: 'item_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'Read',
              arguments: '{"first":true}',
            },
            {
              id: 'item_2',
              type: 'function_call',
              call_id: 'call_2',
              name: 'Read',
              arguments: '{"second":true}',
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'after tools' }],
            },
          ],
        }),
      })
    })

    const starts = events.filter((event) => event.type === 'content_block_start')
    expect(starts.map((event) => event.content_block.type)).toEqual([
      'tool_use',
      'tool_use',
      'text',
    ])
    const deltas = events.filter((event) => event.type === 'content_block_delta')
    expect(deltas).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"first":true}' },
    })
    expect(deltas).toContainEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"second":true}' },
    })
    const textDeltaIndex = events.findIndex(
      (event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta',
    )
    const secondToolStop = events.findIndex(
      (event) => event.type === 'content_block_stop' && event.index === 1,
    )
    expect(textDeltaIndex).toBeGreaterThan(secondToolStop)
    assertBlockLifecycle(events)
  })

  it('combines summary parts and emits the final signature last', async () => {
    const events = await collect(async (transformer) => {
      await transformer.push({ type: 'response.created', response: response() })
      await transformer.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'reason_1', type: 'reasoning', encrypted_content: 'early' },
      })
      await transformer.push({
        type: 'response.reasoning_summary_part.added',
        item_id: 'reason_1',
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })
      await transformer.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reason_1',
        output_index: 0,
        summary_index: 0,
        delta: 'one',
      })
      await transformer.push({
        type: 'response.reasoning_summary_part.added',
        item_id: 'reason_1',
        output_index: 0,
        summary_index: 1,
        part: { type: 'summary_text', text: '' },
      })
      await transformer.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reason_1',
        output_index: 0,
        summary_index: 1,
        delta: 'two',
      })
      await transformer.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'reason_1', type: 'reasoning', encrypted_content: 'final' },
      })
      await transformer.push({ type: 'response.completed', response: response() })
    })
    const reasoningDeltas = events.flatMap((event) =>
      event.type === 'content_block_delta' &&
      (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta')
        ? [event.delta]
        : [],
    )
    expect(reasoningDeltas).toEqual([
      { type: 'thinking_delta', thinking: 'one' },
      { type: 'thinking_delta', thinking: '\n\n' },
      { type: 'thinking_delta', thinking: 'two' },
      { type: 'signature_delta', signature: 'final' },
    ])
    assertBlockLifecycle(events)
  })

  it('emits a signature-only thinking block', async () => {
    const events = await collect(async (transformer) => {
      await transformer.push({ type: 'response.created', response: response() })
      await transformer.push({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'reason_1', type: 'reasoning', encrypted_content: 'signature-only' },
      })
      await transformer.push({ type: 'response.completed', response: response() })
    })
    expect(events).toContainEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    expect(events).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signature-only' },
    })
    assertBlockLifecycle(events)
  })

  it('reconstructs text from output_item.done when terminal output is empty', async () => {
    const transformer = new OpenAIResponseTransformer(context())
    const collector = new AnthropicMessageCollector()
    transformer.on((event) => collector.push(event))
    await transformer.push({ type: 'response.created', response: response() })
    await transformer.push({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'recovered' }],
      },
    })
    await transformer.push({ type: 'response.completed', response: response({ output: [] }) })
    await transformer.finish()
    expect(collector.result().content).toEqual([{ type: 'text', text: 'recovered' }])
  })

  it('emits web search blocks once and does not force a tool_use stop reason', async () => {
    const transformer = new OpenAIResponseTransformer(context())
    const collector = new AnthropicMessageCollector()
    transformer.on((event) => collector.push(event))
    await transformer.push({ type: 'response.created', response: response() })
    const item = {
      id: 'search:1',
      type: 'web_search_call' as const,
      action: { type: 'search', query: 'Codex' },
      results: [{ title: 'OpenAI', url: 'https://openai.com' }],
    }
    await transformer.push({ type: 'response.output_item.done', output_index: 0, item })
    await transformer.push({ type: 'response.completed', response: response({ output: [item] }) })
    await transformer.finish()
    const result = collector.result()
    expect(result.content).toEqual([
      { type: 'server_tool_use', id: 'search_1', name: 'web_search', input: { query: 'Codex' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'search_1',
        content: [
          {
            type: 'web_search_result',
            title: 'OpenAI',
            url: 'https://openai.com',
            page_age: null,
          },
        ],
      },
    ])
    expect(result.stop_reason).toBe('end_turn')
  })

  it('awaits listeners in registration order and propagates failures', async () => {
    const transformer = new OpenAIResponseTransformer(context())
    const order: string[] = []
    transformer.on(async () => {
      await Promise.resolve()
      order.push('first')
    })
    transformer.on(() => {
      order.push('second')
    })
    await transformer.push({ type: 'response.created', response: response() })
    expect(order).toEqual(['first', 'second'])

    const failed = new OpenAIResponseTransformer(context())
    failed.on(() => {
      throw new Error('listener failed')
    })
    await expect(failed.push({ type: 'response.created', response: response() })).rejects.toThrow(
      'listener failed',
    )
  })

  it('ignores forward-compatible unknown events and maps failed responses to an error only', async () => {
    const unknown = {
      type: 'unknown',
      upstreamType: 'response.future.delta',
      raw: { type: 'response.future.delta', value: 1 },
    } as const

    const transformer = new OpenAIResponseTransformer(context())
    const events: AnthropicMessageStreamEvent[] = []
    transformer.on((event) => {
      events.push(event)
    })
    await transformer.push(unknown)
    await transformer.push({
      type: 'response.failed',
      response: response({
        status: 'failed',
        error: { code: 'server_error', message: 'generation failed' },
      }),
    })
    await transformer.finish()
    expect(events).toEqual([
      { type: 'error', error: { type: 'api_error', message: 'generation failed' } },
    ])
  })

  it('rejects concurrent pushes, post-terminal pushes, and truncated streams', async () => {
    const transformer = new OpenAIResponseTransformer(context())
    let release: (() => void) | undefined
    transformer.on(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = transformer.push({ type: 'response.created', response: response() })
    await Promise.resolve()
    await expect(
      transformer.push({ type: 'response.created', response: response() }),
    ).rejects.toThrow('Concurrent')
    release?.()
    await first
    await expect(transformer.finish()).rejects.toThrow(ResponseTransformError)

    const complete = new OpenAIResponseTransformer(context())
    await complete.push({ type: 'response.completed', response: response() })
    await complete.finish()
    await expect(complete.push({ type: 'response.created', response: response() })).rejects.toThrow(
      'after',
    )
  })
})
