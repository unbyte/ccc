import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AnthropicMessageRequest } from '../../protocol/anthropic-messages'
import type {
  OpenAIReasoningInputItem,
  OpenAIResponseOutputItem,
} from '../../protocol/openai-responses'
import {
  AnthropicMessageCollector,
  decodeOpenAIResponseEvent,
  OpenAIResponseTransformer,
  transformAnthropicRequest,
} from '../../transformer/openai-responses'
import type { Adaptor } from '..'
import { AdaptorError, writeJson } from '../shared/errors'
import { encodeSse, parseSse } from '../shared/sse'
import { type CodexCredential, loadCodexCredential } from './auth-file'
import { CodexClient, type CodexExecutionScope } from './client'
import { countTokens } from './count-tokens'
import { createModelList, validateModels } from './models'
import {
  type ReasoningReplayItem,
  ReasoningReplayStore,
  replayFingerprint,
} from './reasoning-replay'

export type { CodexCredential } from './auth-file'

const upstreamEventLimit = 50 * 1024 * 1024

/** Codex adaptor configuration. */
export interface CodexAdaptorOptions {
  /** Model IDs exposed unchanged to Claude Code. */
  models: readonly string[]
  /** Explicit credential; defaults to the installed Codex CLI credential. */
  credential?: CodexCredential
}

function metadataSessionId(request: AnthropicMessageRequest) {
  const userId = request.metadata?.user_id
  if (typeof userId !== 'string') return undefined
  const match = userId.match(/(?:session|sess)[_:-]([A-Za-z0-9_-]+)/i)
  return match?.[1] ?? userId
}

function executionScope(
  request: IncomingMessage,
  body: AnthropicMessageRequest,
): CodexExecutionScope {
  const sessionHeader = request.headers['x-claude-code-session-id']
  const agentHeader = request.headers['x-claude-code-agent-id']
  return {
    sessionId:
      (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ||
      metadataSessionId(body) ||
      `process-${process.pid}`,
    agentId: (Array.isArray(agentHeader) ? agentHeader[0] : agentHeader) || 'main',
    model: body.model,
  }
}

async function writeWithBackpressure(response: ServerResponse, chunk: string) {
  if (response.write(chunk)) return
  await once(response, 'drain')
}

function replayItems(items: OpenAIResponseOutputItem[]): ReasoningReplayItem[] {
  return items.flatMap((item): ReasoningReplayItem[] => {
    if (item.type === 'reasoning' && item.encrypted_content) {
      const replay: OpenAIReasoningInputItem = {
        type: 'reasoning',
        summary: [],
        content: null,
        encrypted_content: item.encrypted_content,
      }
      return [replay]
    }
    if (item.type === 'function_call') {
      return [
        {
          type: 'function_call' as const,
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        },
      ]
    }
    return []
  })
}

async function consumeUpstream(
  upstream: Response,
  transformer: OpenAIResponseTransformer,
  scope: CodexExecutionScope,
  replayStore: ReasoningReplayStore,
  requestFingerprint: string,
) {
  if (upstream.body === null)
    throw new AdaptorError('Codex upstream returned no body', 502, 'api_error')
  const doneItems = new Map<number, OpenAIResponseOutputItem>()
  for await (const record of parseSse(upstream.body, upstreamEventLimit)) {
    const event = decodeOpenAIResponseEvent(record.data)
    if (event.type === 'response.output_item.done') doneItems.set(event.output_index, event.item)
    if (event.type === 'error' && event.error.code === 'thinking_signature_invalid') {
      replayStore.clearScope(scope)
    }
    await transformer.push(event)
    if (event.type === 'response.completed') {
      const terminalItems =
        event.response.output.length > 0
          ? event.response.output
          : [...doneItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
      const items = replayItems(terminalItems)
      const callIds = items
        .filter((item) => item.type === 'function_call')
        .map((item) => item.call_id)
      if (callIds.length === 0) continue
      const assistantFingerprint = replayFingerprint(items)
      replayStore.commit(scope, {
        id: replayFingerprint([requestFingerprint, assistantFingerprint]),
        requestFingerprint,
        assistantFingerprint,
        callIds,
        items,
      })
    }
  }
  await transformer.finish()
}

export class CodexAdaptor implements Adaptor {
  private readonly replayStore = new ReasoningReplayStore()
  private readonly controllers = new Set<AbortController>()

  private constructor(
    private readonly modelIds: string[],
    private readonly client: CodexClient,
  ) {}

  static async create(options: CodexAdaptorOptions) {
    const modelIds = validateModels(options.models)
    const credential = options.credential ?? (await loadCodexCredential())
    return new CodexAdaptor(modelIds, new CodexClient(credential))
  }

  models() {
    return createModelList(this.modelIds)
  }

  countTokens(request: AnthropicMessageRequest) {
    const transformed = this.transformRequest(request)
    return { input_tokens: countTokens(transformed.request, request) }
  }

  async messages(
    incoming: IncomingMessage,
    response: ServerResponse,
    request: AnthropicMessageRequest,
  ) {
    const transformed = this.transformRequest(request)
    const scope = executionScope(incoming, request)
    transformed.request.input = this.replayStore.replay(scope, transformed.request.input)
    const controller = new AbortController()
    this.controllers.add(controller)
    incoming.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })

    try {
      const upstream = await this.client.createResponse(
        transformed.request,
        scope,
        controller.signal,
      )
      const transformer = new OpenAIResponseTransformer(transformed.context)
      if (request.stream === true) {
        response.statusCode = 200
        response.setHeader('content-type', 'text/event-stream')
        response.setHeader('cache-control', 'no-cache')
        response.setHeader('connection', 'keep-alive')
        transformer.on((event) => writeWithBackpressure(response, encodeSse(event)))
        await consumeUpstream(
          upstream,
          transformer,
          scope,
          this.replayStore,
          replayFingerprint(transformed.request.input),
        )
        response.end()
        return
      }

      const collector = new AnthropicMessageCollector()
      transformer.on((event) => collector.push(event))
      await consumeUpstream(
        upstream,
        transformer,
        scope,
        this.replayStore,
        replayFingerprint(transformed.request.input),
      )
      writeJson(response, 200, collector.result())
    } finally {
      this.controllers.delete(controller)
    }
  }

  close() {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.replayStore.clear()
  }

  private transformRequest(request: AnthropicMessageRequest) {
    if (!this.modelIds.includes(request.model)) {
      throw new AdaptorError(`Unknown model: ${request.model}`, 400, 'invalid_request_error')
    }
    return transformAnthropicRequest(request)
  }
}
