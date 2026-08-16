/** Conversation roles accepted by the Messages compatibility surface. */
export enum AnthropicMessageRole {
  /** Human or tool-result input. */
  User = 'user',
  /** Model output, including historical tool calls. */
  Assistant = 'assistant',
  /** Claude Code's message-level reminder extension. */
  System = 'system',
}

/** MIME metadata and bytes for inline image input. */
export interface AnthropicBase64ImageSource {
  /** Only `base64` sources are translated; other variants are accepted and omitted. */
  type?: string
  /** Preferred MIME type field. */
  media_type?: string
  /** Compatibility MIME type field. */
  mime_type?: string
  /** Preferred base64 payload field. */
  data?: string
  /** Compatibility base64 payload field. */
  base64?: string
}

/** Inline PDF input accepted by the Messages API. */
export interface AnthropicBase64DocumentSource {
  /** Documents must be inline base64 data. */
  type: 'base64'
  /** Only `application/pdf` is translated. */
  media_type: string
  /** Preferred base64 payload field. */
  data?: string
  /** Compatibility base64 payload field. */
  base64?: string
}

/** Plain text within a system prompt or message. */
export interface AnthropicTextBlock {
  /** Text block discriminator. */
  type: 'text'
  /** Literal text content. */
  text: string
  /** Accepted prompt-cache annotation; not forwarded to Responses. */
  cache_control?: unknown
}

/** Inline image content. */
export interface AnthropicImageBlock {
  /** Image block discriminator. */
  type: 'image'
  /** Encoded image source. */
  source: AnthropicBase64ImageSource
}

/** Inline document content. */
export interface AnthropicDocumentBlock {
  /** Document block discriminator. */
  type: 'document'
  /** Encoded PDF source. */
  source: AnthropicBase64DocumentSource
}

/** Visible reasoning plus its opaque replay signature. */
export interface AnthropicThinkingBlock {
  /** Thinking block discriminator. */
  type: 'thinking'
  /** User-visible summarized reasoning. */
  thinking: string
  /** Provider-issued encrypted reasoning value used for replay. */
  signature?: string
}

/** A function invocation Claude Code must execute. */
export interface AnthropicToolUseBlock {
  /** Tool-call block discriminator. */
  type: 'tool_use'
  /** Stable identifier referenced by a later `tool_result.tool_use_id`. */
  id: string
  /** Caller-declared tool name. */
  name: string
  /** Parsed function arguments. */
  input: Record<string, unknown>
}

/** A server-executed tool invocation. */
export interface AnthropicServerToolUseBlock {
  /** Server-tool block discriminator. */
  type: 'server_tool_use'
  /** Identifier referenced by the associated result block. */
  id: string
  /** Server tool name. */
  name: string
  /** Parsed server-tool arguments. */
  input: Record<string, unknown>
}

/** A single web-search result exposed to Claude Code. */
export interface AnthropicWebSearchResult {
  /** Search-result discriminator. */
  type: 'web_search_result'
  /** Display title, falling back to the URL. */
  title: string
  /** Result URL. */
  url: string
  /** Page-age placeholder used by the compatibility surface. */
  page_age: null
}

/** Results associated with a server-side web-search call. */
export interface AnthropicWebSearchToolResultBlock {
  /** Web-search result block discriminator. */
  type: 'web_search_tool_result'
  /** ID of the matching `server_tool_use` block. */
  tool_use_id: string
  /** Sanitized result entries. */
  content: AnthropicWebSearchResult[]
}
