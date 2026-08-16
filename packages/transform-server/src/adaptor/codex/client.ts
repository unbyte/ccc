import { createHash } from 'node:crypto'
import type { OpenAIResponsesRequest } from '../../protocol/openai-responses'
import { AdaptorError, anthropicErrorType } from '../shared/errors'
import { type CodexCredential, loadCodexCredential } from './auth-file'

/** Per-request identity used for cache and replay isolation. */
export interface CodexExecutionScope {
  /** Claude Code session or process fallback. */
  sessionId: string
  /** Root is `main`; subagents use their own IDs. */
  agentId: string
  /** Caller-selected model. */
  model: string
}

/** Fixed backend compatibility profile pinned by the implementation plan. */
const codexCompatibilityProfile = {
  responsesUrl: 'https://chatgpt.com/backend-api/codex/responses',
  originator: 'codex-tui',
  userAgent: 'codex-tui/0.146.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.146.0)',
} as const

/** Derives the stable per-model, per-Claude-execution identifier used upstream. */
function codexSessionId(scope: CodexExecutionScope) {
  return createHash('sha256')
    .update(`${scope.model}\0${scope.sessionId}\0${scope.agentId}`)
    .digest('hex')
}

/** Fixed-endpoint Codex Responses client. */
export class CodexClient {
  constructor(private readonly credential?: CodexCredential) {}

  async createResponse(
    request: OpenAIResponsesRequest,
    scope: CodexExecutionScope,
    signal: AbortSignal,
  ) {
    const credential = this.credential ?? (await loadCodexCredential())
    const sessionId = codexSessionId(scope)
    const body: OpenAIResponsesRequest = { ...request, prompt_cache_key: sessionId }
    const headers = new Headers({
      authorization: `Bearer ${credential.accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: codexCompatibilityProfile.originator,
      'user-agent': codexCompatibilityProfile.userAgent,
      'session-id': sessionId,
    })
    if (credential.accountId !== undefined) {
      headers.set('chatgpt-account-id', credential.accountId)
    }
    const response = await fetch(codexCompatibilityProfile.responsesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const status = response.status
      const authentication = status === 401
      throw new AdaptorError(
        authentication
          ? 'Codex authentication failed. Run `codex login` and retry.'
          : `Codex upstream request failed with HTTP ${status}`,
        status,
        anthropicErrorType(status),
      )
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw new AdaptorError('Codex upstream did not return an event stream', 502, 'api_error')
    }
    return response
  }
}
