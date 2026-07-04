import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import type { Adaptor, AdaptorOptions } from './adaptor'
import { type Ant, parseRequest, Responder, toolResultText } from './anthropic-message'
import { OpenAICompletionsAdaptor } from './openai-completions'

// Loopback only: the upstream key lives in this process and the server must
// never be reachable from other hosts.
const HOST = '127.0.0.1'

export interface TransformServerOptions extends AdaptorOptions {
  type: 'openai-completions'
}

export interface TransformServerHandle {
  /** Base URL to hand to Claude Code as `ANTHROPIC_BASE_URL`. */
  url: string
  port: number
  close(): Promise<void>
}

export class TransformServer {
  static create(options: TransformServerOptions): TransformServer {
    switch (options.type) {
      case 'openai-completions':
        return new TransformServer(new OpenAICompletionsAdaptor(options))
      default:
        throw new Error(`Unsupported transform: ${options.type}`)
    }
  }

  private constructor(private readonly adaptor: Adaptor) {}

  listen(): Promise<TransformServerHandle> {
    const server = createServer((req, res) => {
      const responder = new Responder(res)
      this.route(req, responder).catch((error) => {
        responder.error(500, error instanceof Error ? error.message : String(error))
      })
    })

    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, HOST, () => {
        server.removeListener('error', reject)
        const { port } = server.address() as AddressInfo
        resolve({
          url: `http://${HOST}:${port}`,
          port,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res())
            }),
        })
      })
    })
  }

  private async route(req: IncomingMessage, responder: Responder) {
    const path = (req.url ?? '').split('?')[0]
    const method = req.method ?? 'GET'

    if (method === 'GET' && (path === '/' || path === '/health')) {
      responder.json(200, { status: 'ok' })
      return
    }

    if (method !== 'POST') {
      responder.error(404, `not found: ${method} ${path}`)
      return
    }

    const raw = await text(req)
    let request: Ant.Request
    try {
      request = parseRequest(JSON.parse(raw))
    } catch {
      responder.error(400, 'request body is not valid JSON')
      return
    }

    if (path === '/v1/messages/count_tokens') {
      responder.json(200, { input_tokens: estimateTokens(request) })
      return
    }
    if (path === '/v1/messages') {
      await this.adaptor.handle({ request, responder })
      return
    }

    responder.error(404, `not found: ${method} ${path}`)
  }
}

// Most OpenAI-compatible providers have no count_tokens endpoint, so estimate
// locally (~4 chars per token) to feed Claude Code's context meter.
function estimateTokens(req: Ant.Request) {
  let chars = 0
  for (const block of req.system) chars += block.text.length
  for (const message of req.messages) {
    for (const block of message.content) {
      if (block.type === 'text') chars += (block.text ?? '').length
      else if (block.type === 'thinking') chars += (block.thinking ?? '').length
      else if (block.type === 'tool_result') chars += toolResultText(block.content).length
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input ?? {}).length
    }
  }
  return Math.ceil(chars / 4)
}
