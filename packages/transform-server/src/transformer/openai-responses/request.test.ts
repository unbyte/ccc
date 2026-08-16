import { describe, expect, it } from 'vitest'
import {
  type AnthropicMessageRequest,
  AnthropicMessageRole,
} from '../../protocol/anthropic-messages'
import { transformAnthropicRequest } from './request'

function request(overrides: Partial<AnthropicMessageRequest> = {}): AnthropicMessageRequest {
  return {
    model: 'gpt-5.4',
    max_tokens: 4096,
    messages: [{ role: AnthropicMessageRole.User, content: 'Hello' }],
    ...overrides,
  }
}

function validSignature() {
  const payload = Buffer.alloc(1 + 8 + 16 + 16 + 32)
  payload[0] = 0x80
  for (let index = 9; index < payload.length; index += 1) payload[index] = index
  return payload.toString('base64url')
}

describe('transformAnthropicRequest', () => {
  it('sets Codex-compatible base fields and deliberately drops Anthropic generation controls', () => {
    const transformed = transformAnthropicRequest(
      request({
        stream: false,
        max_tokens: 99,
        temperature: 0.2,
        top_p: 0.8,
        top_k: 20,
        stop_sequences: ['stop'],
        metadata: { user_id: 'session-test' },
      }),
    ).request

    expect(transformed).toMatchObject({
      model: 'gpt-5.4',
      instructions: '',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
      reasoning: { effort: 'medium' },
    })
    expect(transformed).not.toHaveProperty('max_output_tokens')
    expect(transformed).not.toHaveProperty('temperature')
    expect(transformed).not.toHaveProperty('top_p')
    expect(transformed).not.toHaveProperty('top_k')
    expect(transformed).not.toHaveProperty('stop')
    expect(transformed).not.toHaveProperty('metadata')
  })

  it('filters billing attribution and preserves mixed block ordering across flushes', () => {
    const signature = validSignature()
    const transformed = transformAnthropicRequest(
      request({
        system: [
          { type: 'text', text: '  x-anthropic-billing-header: test' },
          { type: 'text', text: 'Developer instruction' },
        ],
        messages: [
          {
            role: AnthropicMessageRole.Assistant,
            content: [
              { type: 'text', text: 'A' },
              { type: 'thinking', thinking: 'hidden', signature: `gpt#${signature}` },
              { type: 'text', text: 'B' },
              { type: 'tool_use', id: 'call:1', name: 'Read', input: { path: 'README.md' } },
              { type: 'text', text: 'C' },
            ],
          },
          {
            role: AnthropicMessageRole.User,
            content: [
              { type: 'tool_result', tool_use_id: 'call:1', content: 'contents', is_error: true },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
              },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
              },
            ],
          },
        ],
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      }),
    ).request

    expect(transformed.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Developer instruction' }],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
      { type: 'reasoning', summary: [], content: null, encrypted_content: signature },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] },
      {
        type: 'function_call',
        call_id: 'call:1',
        name: 'Read',
        arguments: '{"path":"README.md"}',
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'C' }] },
      { type: 'function_call_output', call_id: 'call:1', output: 'contents' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
          {
            type: 'input_file',
            file_data: 'data:application/pdf;base64,cGRm',
            filename: 'document.pdf',
          },
        ],
      },
    ])
  })

  it('normalizes function schemas, web search, tool choice, parallelism, and service tier', () => {
    const transformed = transformAnthropicRequest(
      request({
        tools: [
          {
            name: 'lookup',
            description: 'Lookup data',
            input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
            cache_control: { type: 'ephemeral' },
            defer_loading: true,
          },
          {
            type: 'web_search_20260209',
            name: 'web_search',
            allowed_domains: ['example.com'],
            blocked_domains: ['blocked.example'],
            user_location: { country: 'CN' },
          },
        ],
        tool_choice: { type: 'tool', name: 'web_search', disable_parallel_tool_use: true },
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'HIGH' },
        speed: 'fast',
      }),
    ).request

    expect(transformed.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Lookup data',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
      {
        type: 'web_search',
        filters: { allowed_domains: ['example.com'] },
        user_location: { country: 'CN' },
      },
    ])
    expect(transformed.tool_choice).toEqual({ type: 'web_search' })
    expect(transformed.parallel_tool_calls).toBe(false)
    expect(transformed.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(transformed.service_tier).toBe('priority')
  })

  it.each([
    [0, 'none'],
    [1, 'minimal'],
    [512, 'minimal'],
    [513, 'low'],
    [1025, 'medium'],
    [8193, 'high'],
    [24577, 'xhigh'],
  ])('maps a %i thinking budget to %s effort', (budget, effort) => {
    const transformed = transformAnthropicRequest(
      request({ thinking: { type: 'enabled', budget_tokens: budget } }),
    )
    expect(transformed.request.reasoning.effort).toBe(effort)
  })

  it('omits unsupported image and reasoning signature variants', () => {
    const transformed = transformAnthropicRequest(
      request({
        messages: [
          {
            role: AnthropicMessageRole.Assistant,
            content: [{ type: 'thinking', thinking: 'foreign', signature: 'claude#not-gpt' }],
          },
          {
            role: AnthropicMessageRole.User,
            content: [
              {
                type: 'image',
                source: { type: 'url', media_type: 'image/png', data: 'ignored' },
              },
            ],
          },
        ],
      }),
    )
    expect(transformed.request.input).toEqual([])
  })
})
