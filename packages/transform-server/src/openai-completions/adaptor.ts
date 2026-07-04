import type { AdaptorContext, AdaptorOptions } from '../adaptor'
import { Adaptor } from '../adaptor'
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

  async handle({ request, responder }: AdaptorContext) {
    const openaiReq = new RequestTransformer(request, this.reasoning).transform()

    const upstream = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(openaiReq),
    })

    if (!upstream.ok) {
      const text = await upstream.text()
      responder.error(upstream.status, extractErrorMessage(text))
      return
    }

    if (request.stream) {
      const write = responder.stream()
      await new StreamTransformer(request.model, write).consume(upstream.body)
      responder.end()
    } else {
      const openaiResp = (await upstream.json()) as OAI.Response
      responder.json(200, new ResponseTransformer(openaiResp, request.model).transform())
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
