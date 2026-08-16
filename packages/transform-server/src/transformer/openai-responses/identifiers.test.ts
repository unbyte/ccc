import { describe, expect, it } from 'vitest'
import { createToolNameMaps, shortenCallId } from './identifiers'

describe('identifier handling', () => {
  it('enforces byte limits and resolves colliding long names deterministically', () => {
    const shared = `mcp__server__${'long_segment_'.repeat(8)}`
    const names = [shared, `${shared}a`, `${shared}b`]
    const { toolNames, originalToolNames } = createToolNameMaps(names)
    expect([...toolNames.values()].map((name) => Buffer.byteLength(name))).toEqual(
      expect.arrayContaining([expect.any(Number)]),
    )
    for (const [original, shortened] of toolNames) {
      expect(Buffer.byteLength(shortened)).toBeLessThanOrEqual(64)
      expect(originalToolNames.get(shortened)).toBe(original)
    }
    expect(new Set(toolNames.values()).size).toBe(3)
    expect(createToolNameMaps(names).toolNames).toEqual(toolNames)
  })

  it('shortens call IDs stably to at most 64 bytes', () => {
    const id = `toolu_${'long_identifier_'.repeat(8)}`
    expect(shortenCallId(id)).toBe(shortenCallId(id))
    expect(Buffer.byteLength(shortenCallId(id))).toBeLessThanOrEqual(64)
  })
})
