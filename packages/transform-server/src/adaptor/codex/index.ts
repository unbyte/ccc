import { once } from 'node:events'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  type AnthropicMessageRequest,
  isAnthropicMessageRequest,
} from '../../protocol/anthropic-messages'
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
import { readJsonBody } from '../shared/body'
import { AdaptorError, errorEnvelope, normalizeAdaptorError, writeJson } from '../shared/errors'
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

const requestBodyLimit = 32 * 1024 * 1024
const upstreamEventLimit = 50 * 1024 * 1024

/** Codex adaptor configuration. */
export interface RegisterCodexAdaptorOptions {
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

function isJsonContentType(request: IncomingMessage) {
  return (
    request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  )
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

/** Attaches the standalone Codex adaptor after validating startup credentials and models. */
export async function registerCodexAdaptor(server: Server, options: RegisterCodexAdaptorOptions) {
  const models = validateModels(options.models)
  if (options.credential === undefined) await loadCodexCredential()
  const client = new CodexClient(options.credential)
  const replayStore = new ReasoningReplayStore()
  const controllers = new Set<AbortController>()

  const listener = async (request: IncomingMessage, response: ServerResponse) => {
    let streamStarted = false
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const knownPath = ['/v1/messages', '/v1/messages/count_tokens', '/v1/models'].includes(
        url.pathname,
      )
      if (!knownPath) {
        writeJson(response, 404, errorEnvelope('not_found_error', 'Route not found'))
        return
      }
      const expectedMethod = url.pathname === '/v1/models' ? 'GET' : 'POST'
      if (request.method !== expectedMethod) {
        response.setHeader('allow', expectedMethod)
        writeJson(response, 405, errorEnvelope('invalid_request_error', 'Method not allowed'))
        return
      }
      if (url.pathname === '/v1/models') {
        writeJson(response, 200, createModelList(models))
        return
      }
      if (!isJsonContentType(request)) {
        throw new AdaptorError(
          'Content-Type must be application/json',
          415,
          'invalid_request_error',
        )
      }
      const decoded = await readJsonBody(request, requestBodyLimit)
      if (!isAnthropicMessageRequest(decoded)) {
        throw new AdaptorError(
          'Request must include model, max_tokens, and valid messages',
          400,
          'invalid_request_error',
        )
      }
      const body = decoded
      if (!models.includes(body.model)) {
        throw new AdaptorError(`Unknown model: ${body.model}`, 400, 'invalid_request_error')
      }
      const transformed = transformAnthropicRequest(body)
      if (url.pathname === '/v1/messages/count_tokens') {
        writeJson(response, 200, { input_tokens: countTokens(transformed.request, body) })
        return
      }

      const scope = executionScope(request, body)
      transformed.request.input = replayStore.replay(scope, transformed.request.input)
      const controller = new AbortController()
      controllers.add(controller)
      request.once('aborted', () => controller.abort())
      response.once('close', () => {
        if (!response.writableEnded) controller.abort()
      })
      try {
        const upstream = await client.createResponse(transformed.request, scope, controller.signal)
        const transformer = new OpenAIResponseTransformer(transformed.context)
        if (body.stream === true) {
          response.statusCode = 200
          response.setHeader('content-type', 'text/event-stream')
          response.setHeader('cache-control', 'no-cache')
          response.setHeader('connection', 'keep-alive')
          streamStarted = true
          transformer.on((event) => writeWithBackpressure(response, encodeSse(event)))
          await consumeUpstream(
            upstream,
            transformer,
            scope,
            replayStore,
            replayFingerprint(transformed.request.input),
          )
          response.end()
        } else {
          const collector = new AnthropicMessageCollector()
          transformer.on((event) => collector.push(event))
          await consumeUpstream(
            upstream,
            transformer,
            scope,
            replayStore,
            replayFingerprint(transformed.request.input),
          )
          writeJson(response, 200, collector.result())
        }
      } finally {
        controllers.delete(controller)
      }
    } catch (error) {
      const normalized = normalizeAdaptorError(error)
      if (streamStarted && !response.writableEnded) {
        await writeWithBackpressure(
          response,
          encodeSse(errorEnvelope(normalized.type, normalized.message)),
        )
        response.end()
      } else if (!response.headersSent) {
        writeJson(response, normalized.status, errorEnvelope(normalized.type, normalized.message))
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  }

  server.on('request', listener)
  let closed = false
  return () => {
    if (closed) return
    closed = true
    server.off('request', listener)
    for (const controller of controllers) controller.abort()
    controllers.clear()
    replayStore.clear()
  }
}
