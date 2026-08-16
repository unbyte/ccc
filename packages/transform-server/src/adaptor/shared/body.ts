import type { IncomingMessage } from 'node:http'
import { AdaptorError } from './errors'

/** Reads and parses one JSON body while enforcing a raw byte limit. */
export async function readJsonBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > maxBytes) {
      throw new AdaptorError(`Request body exceeds ${maxBytes} bytes`, 413, 'request_too_large')
    }
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new SyntaxError('Request body is not valid JSON')
  }
}
