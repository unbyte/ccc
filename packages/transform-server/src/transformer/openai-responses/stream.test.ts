import { describe, expect, it } from 'vitest'
import { decodeOpenAIResponseEvent } from './stream'

describe('decodeOpenAIResponseEvent', () => {
  it('wraps unknown upstream events without losing their JSON', () => {
    expect(decodeOpenAIResponseEvent('{"type":"response.future.delta","value":1}')).toEqual({
      type: 'unknown',
      upstreamType: 'response.future.delta',
      raw: { type: 'response.future.delta', value: 1 },
    })
  })

  it('rejects malformed event JSON', () => {
    expect(() => decodeOpenAIResponseEvent('{')).toThrow('Malformed Responses event JSON')
    expect(() => decodeOpenAIResponseEvent('{"value":1}')).toThrow(
      'Responses event must be an object with a string type',
    )
  })
})
