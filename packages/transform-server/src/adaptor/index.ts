import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AnthropicMessageRequest,
  AnthropicModelListResponse,
  AnthropicTokenCountResponse,
} from '../protocol/anthropic-messages'

export interface Adaptor {
  models(): AnthropicModelListResponse
  countTokens(request: AnthropicMessageRequest): AnthropicTokenCountResponse
  messages(
    incoming: IncomingMessage,
    response: ServerResponse,
    request: AnthropicMessageRequest,
  ): Promise<void>
  close(): void
}
