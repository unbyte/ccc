import { describe, expect, it } from 'vitest'
import type { ReasoningOptions } from '../adaptor'
import { type Ant, parseRequest } from '../anthropic-message'
import { RequestTransformer } from './request'

// Fixtures use the raw wire shapes Claude Code sends; route them through
// parseRequest so the tests exercise the real parse -> transform pipeline.
function transform(req: unknown, reasoning?: ReasoningOptions) {
  return new RequestTransformer(parseRequest(req), reasoning).transform()
}

describe('RequestTransformer', () => {
  it('prepends a system message from string system', () => {
    const out = transform({
      model: 'm',
      system: 'be nice',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be nice' })
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('joins array-shaped system blocks into one system message', () => {
    const out = transform({
      model: 'm',
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ] as unknown,
      messages: [],
    })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'a\nb' })
  })

  it('strips a leading billing header from system but keeps the prompt', () => {
    const out = transform({
      model: 'm',
      system: 'x-anthropic-billing-header: cch=abc\n\nbe nice',
      messages: [],
    })
    expect(out.messages[0]).toEqual({ role: 'system', content: 'be nice' })
  })

  it('emits tool messages before trailing user text', () => {
    const out = transform({
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
    const out = transform({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'r' }] },
      ],
    })
    expect(out.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'r' }])
  })

  it('concatenates an all-text tool_result but preserves non-text content as JSON', () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    }
    const out = transform({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'a',
              content: [
                { type: 'text', text: 'foo' },
                { type: 'text', text: 'bar' },
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'b',
              content: [{ type: 'text', text: 'see' }, image],
            },
          ],
        },
      ],
    })
    expect(out.messages[0]).toEqual({ role: 'tool', tool_call_id: 'a', content: 'foobar' })
    expect(out.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      content: JSON.stringify([{ type: 'text', text: 'see' }, image]),
    })
  })

  it('maps assistant thinking + tool_use to tool_calls (reasoning gated off by default)', () => {
    const out = transform({
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
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
      ],
    })
  })

  it('attaches reasoning_content on tool-call turns when preserveContent is set', () => {
    const out = transform(
      {
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
      },
      { preserveContent: true },
    )
    expect(out.messages[0].reasoning_content).toBe('hmm')
  })

  it('falls back to a placeholder reasoning_content when a tool-call turn has no thinking', () => {
    const out = transform(
      {
        model: 'm',
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] },
        ],
      },
      { preserveContent: true },
    )
    expect(out.messages[0].reasoning_content).toBe('tool call')
  })

  it('stringifies empty tool input as {}', () => {
    const out = transform({
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'n', input: {} }] },
      ],
    })
    expect(out.messages[0].tool_calls?.[0].function.arguments).toBe('{}')
  })

  it('builds a multimodal user message from text + image', () => {
    const out = transform({
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

  it('sanitizes tool schemas, strips format:uri, drops nameless and BatchTool tools', () => {
    const out = transform({
      model: 'm',
      messages: [],
      tools: [
        {
          name: 'ok',
          description: 'd',
          input_schema: { type: 'object', properties: { u: { type: 'string', format: 'uri' } } },
        },
        { name: 'empty', input_schema: {} },
        { name: '  ', input_schema: {} },
        { name: 'batch', input_schema: {}, type: 'BatchTool' } as unknown as Ant.Tool,
      ],
    })
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'ok',
          description: 'd',
          parameters: { type: 'object', properties: { u: { type: 'string' } } },
        },
      },
      {
        type: 'function',
        function: {
          name: 'empty',
          description: undefined,
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ])
  })

  it('routes max_tokens to max_completion_tokens for o-series models', () => {
    expect(transform({ model: 'o3', messages: [], max_tokens: 100 }).max_completion_tokens).toBe(
      100,
    )
    expect(transform({ model: 'o3', messages: [], max_tokens: 100 }).max_tokens).toBeUndefined()
    expect(transform({ model: 'gpt-4o', messages: [], max_tokens: 100 }).max_tokens).toBe(100)
  })

  it('maps effort to reasoning_effort only for models present in the effortMapping', () => {
    const req = { model: 'gpt-5', messages: [], output_config: { effort: 'max' } }
    // No mapping at all -> nothing sent.
    expect(transform(req).reasoning_effort).toBeUndefined()
    // Model listed -> its per-level token is used.
    expect(transform(req, { effortMapping: { 'gpt-5': { max: 'xhigh' } } }).reasoning_effort).toBe(
      'xhigh',
    )
    // Model absent from the map -> treated as not supporting reasoning.
    expect(
      transform(req, { effortMapping: { 'other-model': { max: 'xhigh' } } }).reasoning_effort,
    ).toBeUndefined()
  })

  it('derives the effort level from thinking budget', () => {
    const req = {
      model: 'm',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 20000 },
    }
    expect(transform(req, { effortMapping: { m: { high: 'high' } } }).reasoning_effort).toBe('high')
  })

  it('sends nothing when the resolved level is not mapped for the model', () => {
    const req = { model: 'm', messages: [], output_config: { effort: 'medium' } }
    expect(
      transform(req, { effortMapping: { m: { low: 'low', high: 'high' } } }).reasoning_effort,
    ).toBeUndefined()
  })

  it('sets stream_options when streaming', () => {
    const out = transform({ model: 'm', messages: [], stream: true })
    expect(out.stream).toBe(true)
    expect(out.stream_options).toEqual({ include_usage: true })
  })

  it('maps tool_choice and stop_sequences', () => {
    const out = transform({
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
