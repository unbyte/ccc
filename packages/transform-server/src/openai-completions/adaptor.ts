import type { AdaptorContext, AdaptorOptions } from '../adaptor'
import { Adaptor } from '../adaptor'
import { sendError, sendJson } from '../http'
import { RequestTransformer } from './request'
import { ResponseTransformer } from './response'
import { StreamTransformer } from './stream'
import type { OAI } from './types'

export class OpenAICompletionsAdaptor extends Adaptor {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(options: AdaptorOptions) {
    super(options)
    this.baseUrl = `${options.api.replace(/\/+$/, '')}/chat/completions`
    this.headers = {
      'content-type': 'application/json',
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    }
  }

  async handle({ res, anthropic }: AdaptorContext) {
    const openaiReq = new RequestTransformer(anthropic, this.reasoning).transform()

    const upstream = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(openaiReq),
    })

    if (!upstream.ok) {
      const text = await upstream.text()
      sendError(res, upstream.status, extractErrorMessage(text))
      return
    }

    if (anthropic.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      res.flushHeaders()
      const transformer = new StreamTransformer(anthropic.model, (chunk) => res.write(chunk))
      await transformer.consume(upstream.body)
      res.end()
    } else {
      const openaiResp = (await upstream.json()) as OAI.Response
      sendJson(res, 200, new ResponseTransformer(openaiResp, anthropic.model).transform())
    }
  }
}

function extractErrorMessage(body: string) {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    if (typeof parsed.error === 'string') return parsed.error
    return parsed.error?.message ?? parsed.message ?? body
  } catch {
    return body || 'upstream request failed'
  }
}
