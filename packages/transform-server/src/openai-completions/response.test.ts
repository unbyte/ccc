import { describe, expect, it } from 'vitest'
import { mapUsage, ResponseTransformer } from './response'
import type { OAI } from './types'

function transform(resp: OAI.Response, model = 'claude-model') {
  return new ResponseTransformer(resp, model).transform()
}

describe('ResponseTransformer', () => {
  it('builds thinking, text, then tool_use blocks in order', () => {
    const out = transform({
      id: 'resp_1',
      choices: [
        {
          message: {
            content: 'answer',
            reasoning_content: 'because',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    expect(out.model).toBe('claude-model')
    expect(out.stop_reason).toBe('tool_use')
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'because', signature: '' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
    ])
  })

  it('collects text/refusal from content parts and a message-level refusal', () => {
    const out = transform({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: 'hi' },
              { type: 'refusal', refusal: 'no' },
            ],
            refusal: 'nope',
          },
          finish_reason: 'stop',
        },
      ],
    })
    expect(out.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'no' },
      { type: 'text', text: 'nope' },
    ])
  })

  it('maps a legacy function_call to tool_use', () => {
    const out = transform({
      choices: [
        {
          message: { content: null, function_call: { name: 'f', arguments: '{"a":1}' } },
          finish_reason: 'function_call',
        },
      ],
    })
    expect(out.content).toEqual([
      { type: 'tool_use', id: expect.any(String), name: 'f', input: { a: 1 } },
    ])
    expect(out.stop_reason).toBe('tool_use')
  })

  it('falls back to tool_use when a tool call has no finish_reason', () => {
    const out = transform({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }],
          },
        },
      ],
    })
    expect(out.stop_reason).toBe('tool_use')
  })

  it('always emits at least one block', () => {
    const out = transform({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })
    expect(out.content).toEqual([{ type: 'text', text: '' }])
    expect(out.stop_reason).toBe('end_turn')
  })
})

describe('mapUsage', () => {
  it('subtracts cached tokens from input_tokens (OpenAI-style)', () => {
    expect(
      mapUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      }),
    ).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    })
  })

  it('subtracts cache hits (DeepSeek-style)', () => {
    expect(
      mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 }),
    ).toEqual({
      input_tokens: 60,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    })
  })

  it('subtracts both cache_read and cache_creation, clamping at zero', () => {
    expect(
      mapUsage({
        prompt_tokens: 50,
        completion_tokens: 5,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 20,
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 20,
    })
  })
})
