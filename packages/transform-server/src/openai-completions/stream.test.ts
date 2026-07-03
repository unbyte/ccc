import { describe, expect, it } from 'vitest'
import { StreamTransformer } from './stream'
import type { OAI } from './types'

const enc = (s: string) => new TextEncoder().encode(s)

function streamOf(...parts: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

function parseEvent(block: string) {
  const [eventLine, dataLine] = block.trimEnd().split('\n')
  return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown> }
}

// Feed a raw SSE body through the transformer and collect the Anthropic events
// it emits, as parsed { event, data } pairs.
async function run(body: ReadableStream<Uint8Array> | null) {
  const raw: string[] = []
  const transformer = new StreamTransformer('m', (chunk) => raw.push(chunk), 'msg_test')
  await transformer.consume(body)
  return raw.map(parseEvent)
}

// Encode parsed chunks as an OpenAI SSE body (with a trailing [DONE]).
function collect(chunks: OAI.StreamChunk[]) {
  return run(streamOf(...chunks.map((c) => enc(`data: ${JSON.stringify(c)}\n\n`)), enc('data: [DONE]\n\n')))
}

function textOf(events: { event: string; data: Record<string, unknown> }[]) {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.data.delta as { type: string; text?: string })
    .filter((d) => d.type === 'text_delta')
    .map((d) => d.text ?? '')
    .join('')
}

describe('StreamTransformer', () => {
  it('emits a well-formed text stream', async () => {
    const events = await collect([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ])

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_delta',
      'message_stop',
    ])
    expect(events[1].data).toMatchObject({ index: 0, content_block: { type: 'text' } })
    expect(events[2].data).toMatchObject({ index: 0, delta: { type: 'text_delta', text: 'Hel' } })
    expect(events[5].data).toMatchObject({ delta: { stop_reason: 'end_turn' } })
  })

  it('transitions from thinking to text with distinct block indices', async () => {
    const events = await collect([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'say' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const starts = events.filter((e) => e.event === 'content_block_start')
    expect(starts).toHaveLength(2)
    expect(starts[0].data).toMatchObject({ index: 0, content_block: { type: 'thinking' } })
    expect(starts[1].data).toMatchObject({ index: 1, content_block: { type: 'text' } })
    // thinking block (0) is closed before the text block (1) opens.
    const order = events.map((e) => e.event)
    expect(order.indexOf('content_block_stop')).toBeLessThan(order.lastIndexOf('content_block_start'))
  })

  it('streams tool calls: first chunk opens, later chunks append args', async () => {
    const events = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const start = events.find((e) => e.event === 'content_block_start')
    expect(start?.data).toMatchObject({ index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'search' } })
    const deltas = events.filter((e) => e.event === 'content_block_delta')
    expect(deltas.map((d) => (d.data.delta as { partial_json: string }).partial_json)).toEqual(['{"q":', '"x"}'])
    expect(events.find((e) => e.event === 'message_delta')?.data).toMatchObject({ delta: { stop_reason: 'tool_use' } })
  })

  it('keeps a text block and following tool call at contiguous indices', async () => {
    const events = await collect([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const starts = events.filter((e) => e.event === 'content_block_start')
    expect(starts[0].data).toMatchObject({ index: 0, content_block: { type: 'text' } })
    expect(starts[1].data).toMatchObject({ index: 1, content_block: { type: 'tool_use' } })
  })

  it('closes the message at EOF when the upstream never sent finish_reason', async () => {
    const events = await collect([{ choices: [{ delta: { content: 'partial' } }] }])
    expect(events.at(-1)?.event).toBe('message_stop')
    expect(events.some((e) => e.event === 'message_delta' && (e.data.delta as { stop_reason?: string }).stop_reason === 'end_turn')).toBe(
      true,
    )
  })
})

describe('consume (SSE framing)', () => {
  it('reassembles a data line split across chunk boundaries', async () => {
    const events = await run(streamOf(enc('data: {"choi'), enc('ces":[{"delta":{"content":"hi"}}]}\n\n')))
    expect(textOf(events)).toBe('hi')
  })

  it('decodes a multibyte char split across chunk boundaries', async () => {
    const bytes = enc('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
    // Cut after the first byte of 你 (E4 BD A0) so the decoder must hold the rest.
    const at = bytes.indexOf(0xe4) + 1
    const events = await run(streamOf(bytes.slice(0, at), bytes.slice(at)))
    expect(textOf(events)).toBe('你好')
  })

  it('skips non-data lines and does not parse [DONE]', async () => {
    const events = await run(
      streamOf(
        enc(': keep-alive\n\n'),
        enc('event: message\n'),
        enc('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'),
        enc('data: [DONE]\n\n'),
      ),
    )
    expect(textOf(events)).toBe('a')
    expect(events.at(-1)?.event).toBe('message_stop')
  })

  it('ignores a malformed data line and resyncs on the next', async () => {
    const events = await run(streamOf(enc('data: {bad}\n\n'), enc('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')))
    expect(textOf(events)).toBe('ok')
  })

  it('flushes an empty message when there is no body', async () => {
    const events = await run(null)
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop'])
  })
})
