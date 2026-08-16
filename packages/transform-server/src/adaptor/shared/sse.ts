/** One parsed Server-Sent Event record. */
export interface ParsedSseEvent {
  /** Optional explicit SSE event name. */
  event?: string
  /** Data records joined with newline separators. */
  data: string
}

/** Parses SSE records across arbitrary byte boundaries. */
export async function* parseSse(
  source: AsyncIterable<Uint8Array>,
  maxEventBytes: number,
): AsyncGenerator<ParsedSseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataLines: string[] = []
  let eventBytes = 0

  const dispatch = () => {
    const parsed =
      dataLines.length > 0
        ? {
            event: eventName,
            data: dataLines.join('\n'),
          }
        : undefined
    eventName = undefined
    dataLines = []
    eventBytes = 0
    return parsed
  }

  const consumeLine = (line: string) => {
    if (line === '') return dispatch()
    eventBytes += Buffer.byteLength(line) + 1
    if (eventBytes > maxEventBytes) {
      throw new Error(`Upstream SSE event exceeds ${maxEventBytes} bytes`)
    }
    if (line.startsWith(':')) return undefined
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    let value = separator >= 0 ? line.slice(separator + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    if (field === 'data') {
      dataLines.push(value)
    }
    return undefined
  }

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      let line = buffer.slice(0, newline)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      buffer = buffer.slice(newline + 1)
      const parsed = consumeLine(line)
      if (parsed !== undefined && parsed.data !== '[DONE]') yield parsed
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer) {
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1)
    const parsed = consumeLine(buffer)
    if (parsed !== undefined && parsed.data !== '[DONE]') yield parsed
  }
  const trailing = dispatch()
  if (trailing !== undefined && trailing.data !== '[DONE]') yield trailing
}

/** Serializes an Anthropic stream event as one SSE record. */
export function encodeSse(event: { type: string }) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
