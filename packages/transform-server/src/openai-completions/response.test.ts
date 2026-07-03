import { describe, expect, it } from 'vitest'
import { mapUsage, transformResponse } from './response'

describe('transformResponse', () => {
  it('builds thinking, tool_use, then text blocks in order', () => {
    const out = transformResponse(
      {
        id: 'resp_1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'because',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      'claude-model',
    )
    expect(out.model).toBe('claude-model')
    expect(out.stop_reason).toBe('tool_use')
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'because', signature: '' },
      { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
      { type: 'text', text: 'answer' },
    ])
  })

  it('always emits at least one block', () => {
    const out = transformResponse({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }, 'm')
    expect(out.content).toEqual([{ type: 'text', text: '' }])
    expect(out.stop_reason).toBe('end_turn')
  })
})

describe('mapUsage', () => {
  it('subtracts cached tokens from input_tokens (OpenAI-style)', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } })).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
    })
  })

  it('subtracts cache hits (DeepSeek-style)', () => {
    expect(mapUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 40 })).toEqual({
      input_tokens: 60,
      output_tokens: 5,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 0,
    })
  })
})
