import { once } from 'node:events'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Adaptor } from './adaptor'
import { CodexAdaptor, type CodexAdaptorOptions } from './adaptor/codex'
import {
  AdaptorError,
  errorEnvelope,
  normalizeAdaptorError,
  writeJson,
} from './adaptor/shared/errors'
import { encodeSse } from './adaptor/shared/sse'
import { isAnthropicMessageRequest } from './protocol/anthropic-messages'

export type { CodexCredential } from './adaptor/codex'

const host = '127.0.0.1'
const randomPort = 0
const requestBodyLimit = 32 * 1024 * 1024

interface CodexServerAdaptorOptions extends CodexAdaptorOptions {
  type: 'codex'
}

type ServerAdaptorOptions = CodexServerAdaptorOptions

export interface ServerOptions {
  adaptor: ServerAdaptorOptions
}

export interface TransformServer {
  readonly url: string
  close(): Promise<void>
}

function isJsonContentType(request: IncomingMessage) {
  return (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  )
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > requestBodyLimit) {
      throw new AdaptorError(
        `Request body exceeds ${requestBodyLimit} bytes`,
        413,
        'request_too_large',
      )
    }
    chunks.push(buffer)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new SyntaxError('Request body is not valid JSON')
  }
}

async function readMessageRequest(request: IncomingMessage) {
  if (!isJsonContentType(request)) {
    throw new AdaptorError('Content-Type must be application/json', 415, 'invalid_request_error')
  }
  const decoded = await readJsonBody(request)
  if (!isAnthropicMessageRequest(decoded)) {
    throw new AdaptorError(
      'Request must include model, max_tokens, and valid messages',
      400,
      'invalid_request_error',
    )
  }
  return decoded
}

async function dispatch(adaptor: Adaptor, request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname
  const expectedMethod =
    path === '/v1/models'
      ? 'GET'
      : path === '/v1/messages' || path === '/v1/messages/count_tokens'
        ? 'POST'
        : undefined

  if (expectedMethod === undefined) {
    writeJson(response, 404, errorEnvelope('not_found_error', 'Route not found'))
    return
  }
  if (request.method !== expectedMethod) {
    response.setHeader('allow', expectedMethod)
    writeJson(response, 405, errorEnvelope('invalid_request_error', 'Method not allowed'))
    return
  }
  if (path === '/v1/models') {
    writeJson(response, 200, adaptor.models())
    return
  }

  const body = await readMessageRequest(request)
  if (path === '/v1/messages/count_tokens') {
    writeJson(response, 200, adaptor.countTokens(body))
    return
  }
  await adaptor.messages(request, response, body)
}

function handleError(response: ServerResponse, error: unknown) {
  const normalized = normalizeAdaptorError(error)
  const contentType = response.getHeader('content-type')
  if (
    typeof contentType === 'string' &&
    contentType.startsWith('text/event-stream') &&
    !response.writableEnded
  ) {
    response.write(encodeSse(errorEnvelope(normalized.type, normalized.message)))
    response.end()
  } else if (!response.headersSent) {
    writeJson(response, normalized.status, errorEnvelope(normalized.type, normalized.message))
  } else if (!response.writableEnded) {
    response.end()
  }
}

export async function createServer(options: ServerOptions): Promise<TransformServer> {
  const server = createHttpServer()
  let adaptor: Adaptor
  switch (options.adaptor.type) {
    case 'codex':
      adaptor = await CodexAdaptor.create(options.adaptor)
  }

  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      await dispatch(adaptor, request, response)
    } catch (error) {
      handleError(response, error)
    }
  }
  server.on('request', listener)

  try {
    server.listen(randomPort, host)
    await once(server, 'listening')
  } catch (error) {
    server.off('request', listener)
    adaptor.close()
    throw error
  }

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.off('request', listener)
    adaptor.close()
    server.close()
    throw new Error('Transform server did not bind to a TCP port')
  }

  let closing: Promise<void> | undefined
  const close = () => {
    if (closing !== undefined) return closing
    closing = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
      server.off('request', listener)
      adaptor.close()
      server.closeIdleConnections()
    })
    return closing
  }

  return { url: `http://${host}:${address.port}`, close }
}
