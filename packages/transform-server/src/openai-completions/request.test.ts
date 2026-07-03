import { describe, expect, it } from 'vitest'
import { transformRequest } from './request'

describe('transformRequest', () => {
  it('prepends a system message from string system', () => {
    const out = transformRequest({ model: 'm', system: 'be nice', messages: [{ role: 'user', content: 'hi' }] })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('concatenates array-shaped system blocks', () => {
    const out = transformRequest({
      model: 'm',
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as unknown,
      messages: [],
    })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'ab' })
  })

  it('emits tool messages before trailing user text', () => {
    const out = transformRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: 'result' },
            { type: 'text', text: 'and then' },
          ],
        },
      ],
    })
    expect(out.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      { role: 'user', content: 'and then' },
    ])
  })

  it('does not emit an empty user message when only tool results are present', () => {
    const out = transformRequest({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'r' }] }],
    })
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'r' }])
  })

  it('maps assistant thinking + tool_use to reasoning_content + tool_calls', () => {
    const out = transformRequest({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } },
          ],
        },
      ],
    })
    expect(out.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'hmm',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
    })
  })

  it('stringifies empty tool input as {}', () => {
    const out = transformRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] }],
    })
    expect(out.messages[0].tool_calls?.[0].function.arguments).toBe('{}')
  })

  it('builds a multimodal user message from text + image', () => {
    const out = transformRequest({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    })
    expect(out.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    })
  })

  it('sanitizes tool schemas and drops nameless tools', () => {
    const out = transformRequest({
      model: 'm',
      messages: [],
      tools: [
        { name: 'ok', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } },
        { name: 'empty', input_schema: {} },
        { name: '  ', input_schema: {} },
      ],
    })
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: { name: 'ok', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
      },
      {
        type: 'function',
        function: { name: 'empty', description: undefined, parameters: { type: 'object', properties: {}, additionalProperties: false } },
      },
    ])
  })

  it('sets stream_options when streaming', () => {
    const out = transformRequest({ model: 'm', messages: [], stream: true })
    expect(out.stream).toBe(true)
    expect(out.stream_options).toEqual({ include_usage: true })
  })

  it('maps tool_choice and stop_sequences', () => {
    const out = transformRequest({
      model: 'm',
      messages: [],
      tools: [{ name: 't', input_schema: {} }],
      tool_choice: { type: 'tool', name: 't' },
      stop_sequences: ['STOP'],
    })
    expect(out.tool_choice).toEqual({ type: 'function', function: { name: 't' } })
    expect(out.stop).toEqual(['STOP'])
  })
})
