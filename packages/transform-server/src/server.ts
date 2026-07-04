import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { text } from 'node:stream/consumers'
import type { Adaptor, AdaptorOptions } from './adaptor'
import type { Ant } from './anthropic'
import { contentBlocks, systemText, toolResultText } from './anthropic'
import { sendError, sendJson } from './http'
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
      this.route(req, res).catch((error) => {
        sendError(res, 500, error instanceof Error ? error.message : String(error))
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

  private async route(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? '').split('?')[0]
    const method = req.method ?? 'GET'

    if (method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (method !== 'POST') {
      sendError(res, 404, `not found: ${method} ${path}`)
      return
    }

    const raw = await text(req)
    let anthropic: Ant.Request
    try {
      anthropic = JSON.parse(raw) as Ant.Request
    } catch {
      sendError(res, 400, 'request body is not valid JSON')
      return
    }

    if (path === '/v1/messages/count_tokens') {
      sendJson(res, 200, { input_tokens: estimateTokens(anthropic) })
      return
    }
    if (path === '/v1/messages') {
      await this.adaptor.handle({ req, res, anthropic })
      return
    }

    sendError(res, 404, `not found: ${method} ${path}`)
  }
}

// Most OpenAI-compatible providers have no count_tokens endpoint, so estimate
// locally (~4 chars per token) to feed Claude Code's context meter.
function estimateTokens(req: Ant.Request) {
  let chars = systemText(req.system).length
  for (const message of req.messages ?? []) {
    for (const block of contentBlocks(message.content)) {
      if (block.type === 'text') chars += (block.text ?? '').length
      else if (block.type === 'thinking') chars += (block.thinking ?? '').length
      else if (block.type === 'tool_result') chars += toolResultText(block.content).length
      else if (block.type === 'tool_use') chars += JSON.stringify(block.input ?? {}).length
    }
  }
  return Math.ceil(chars / 4)
}
