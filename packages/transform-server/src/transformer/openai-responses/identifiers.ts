import { createHash } from 'node:crypto'

const identifierByteLimit = 64

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return value

  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break
    result += character
  }
  return result
}

function baseToolName(name: string) {
  if (Buffer.byteLength(name) <= identifierByteLimit) return name

  if (name.startsWith('mcp__')) {
    const separator = name.lastIndexOf('__')
    if (separator > 0) return truncateUtf8(`mcp__${name.slice(separator + 2)}`, identifierByteLimit)
  }
  return truncateUtf8(name, identifierByteLimit)
}

/** Shortens one tool name without request-level collision resolution. */
export function shortenToolName(name: string) {
  return baseToolName(name)
}

/** Builds collision-free, 64-byte-safe tool-name mappings for one request. */
export function createToolNameMaps(names: Iterable<string>) {
  const toolNames = new Map<string, string>()
  const originalToolNames = new Map<string, string>()

  for (const name of names) {
    if (toolNames.has(name)) continue
    const base = baseToolName(name)
    let candidate = base
    let collision = 0
    while (originalToolNames.has(candidate)) {
      collision += 1
      const suffix = `_${collision}`
      candidate = `${truncateUtf8(base, identifierByteLimit - Buffer.byteLength(suffix))}${suffix}`
    }
    toolNames.set(name, candidate)
    originalToolNames.set(candidate, name)
  }

  return { toolNames, originalToolNames }
}

/** Shortens a call ID with a stable SHA-256 suffix when it exceeds 64 bytes. */
export function shortenCallId(id: string) {
  if (Buffer.byteLength(id) <= identifierByteLimit) return id
  const suffix = `_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`
  return `${truncateUtf8(id, identifierByteLimit - Buffer.byteLength(suffix))}${suffix}`
}

/** Produces a Claude-safe tool ID while retaining deterministic length handling. */
export function sanitizeAnthropicToolId(id: string) {
  return shortenCallId(id.replace(/[^A-Za-z0-9_-]/g, '_'))
}

/** Resolves and records a request-side call ID. */
export function mapCallId(
  original: string,
  callIds: Map<string, string>,
  originalCallIds: Map<string, string>,
) {
  const existing = callIds.get(original)
  if (existing !== undefined) return existing
  const shortened = shortenCallId(original)
  callIds.set(original, shortened)
  originalCallIds.set(shortened, original)
  return shortened
}

/** Restores an original request tool name from a Responses-safe name. */
export function restoreToolName(originalToolNames: ReadonlyMap<string, string>, name: string) {
  return originalToolNames.get(name) ?? name
}

/** Restores known IDs, then sanitizes model-created IDs for Anthropic. */
export function restoreCallId(originalCallIds: ReadonlyMap<string, string>, id: string) {
  return sanitizeAnthropicToolId(originalCallIds.get(id) ?? id)
}
