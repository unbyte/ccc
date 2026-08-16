import type {
  AnthropicFunctionTool,
  AnthropicMessageRequest,
  AnthropicRequestContentBlock,
  AnthropicRequestMessage,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  AnthropicWebSearchTool,
} from '../../protocol/anthropic-messages'
import { AnthropicMessageRole } from '../../protocol/anthropic-messages'
import { isJsonObject, type JsonSchema } from '../../protocol/json'
import type {
  OpenAIInputContent,
  OpenAIInputMessage,
  OpenAIResponseInputItem,
  OpenAIResponsesRequest,
  OpenAIResponseTool,
  OpenAIResponseToolChoice,
} from '../../protocol/openai-responses'
import { createToolNameMaps, mapCallId, shortenToolName } from './identifiers'
import { compatibleReasoningSignature, reasoningEffort } from './reasoning'
import type { ResponseTransformContext } from './types'

const billingAttributionPrefix = 'x-anthropic-billing-header:'

function isBillingAttribution(text: string) {
  return text.trimStart().startsWith(billingAttributionPrefix)
}

function imageDataUrl(source: unknown) {
  if (!isJsonObject(source)) return undefined
  if (typeof source.type === 'string' && source.type !== 'base64') return undefined
  const data =
    typeof source.data === 'string'
      ? source.data
      : typeof source.base64 === 'string'
        ? source.base64
        : undefined
  if (!data) return undefined
  const mediaType =
    (typeof source.media_type === 'string' && source.media_type) ||
    (typeof source.mime_type === 'string' && source.mime_type) ||
    'application/octet-stream'
  return `data:${mediaType};base64,${data}`
}

function systemContents(request: AnthropicMessageRequest): OpenAIInputContent[] {
  if (typeof request.system === 'string') {
    return request.system && !isBillingAttribution(request.system)
      ? [{ type: 'input_text', text: request.system }]
      : []
  }
  return (request.system ?? [])
    .filter((block) => block.type === 'text' && block.text && !isBillingAttribution(block.text))
    .map((block) => ({ type: 'input_text' as const, text: block.text }))
}

function messageSystemReminder(message: AnthropicRequestMessage) {
  const texts =
    typeof message.content === 'string'
      ? [message.content]
      : message.content
          .filter((block) => block.type === 'text')
          .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
  const kept = texts.filter((text) => text && !isBillingAttribution(text))
  if (kept.length === 0 || kept.join('\n').trim() === '') return undefined
  return `<system-reminder>\n${kept.join('\n')}\n</system-reminder>`
}

function toolResultOutput(block: AnthropicToolResultBlock) {
  if (!Array.isArray(block.content)) return block.content ?? ''
  const output: Array<
    { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }
  > = []
  for (const part of block.content) {
    if (part.type === 'text') output.push({ type: 'input_text', text: part.text })
    if (part.type === 'image') {
      const imageUrl = imageDataUrl(part.source)
      if (imageUrl !== undefined) output.push({ type: 'input_image', image_url: imageUrl })
    }
  }
  return output.length > 0 ? output : JSON.stringify(block.content)
}

function normalizeToolSchema(schema: unknown): JsonSchema {
  if (!isJsonObject(schema)) return { type: 'object', properties: {} }
  const normalized = structuredClone(schema) as JsonSchema
  delete normalized.$schema
  if (typeof normalized.type !== 'string') normalized.type = 'object'
  if (normalized.type === 'object' && !isJsonObject(normalized.properties))
    normalized.properties = {}
  return normalized
}

function isWebSearchTool(tool: AnthropicTool): tool is AnthropicWebSearchTool {
  return tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209'
}

function transformTool(
  tool: AnthropicTool,
  toolNames: ReadonlyMap<string, string>,
): OpenAIResponseTool {
  if (isWebSearchTool(tool)) {
    return {
      type: 'web_search',
      filters:
        tool.allowed_domains === undefined
          ? undefined
          : { allowed_domains: [...tool.allowed_domains] },
      user_location:
        tool.user_location === undefined ? undefined : structuredClone(tool.user_location),
    }
  }
  const functionTool = tool as AnthropicFunctionTool
  return {
    type: 'function',
    name: toolNames.get(functionTool.name) ?? functionTool.name,
    description: functionTool.description,
    parameters: normalizeToolSchema(functionTool.input_schema),
    strict: false,
  }
}

function transformToolChoice(
  choice: AnthropicToolChoice | undefined,
  tools: AnthropicTool[],
  toolNames: ReadonlyMap<string, string>,
): OpenAIResponseToolChoice {
  if (choice === undefined || choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  const selected = tools.find((tool) => tool.name === choice.name)
  if (selected !== undefined && isWebSearchTool(selected)) return { type: 'web_search' }
  const name = toolNames.get(choice.name) ?? shortenToolName(choice.name)
  return name ? { type: 'function', name } : 'auto'
}

interface MessageTransformState {
  input: OpenAIResponseInputItem[]
  callIds: Map<string, string>
  originalCallIds: Map<string, string>
  toolNames: ReadonlyMap<string, string>
}

function transformMessage(message: AnthropicRequestMessage, state: MessageTransformState) {
  if (message.role === AnthropicMessageRole.System) {
    const reminder = messageSystemReminder(message)
    if (reminder !== undefined) {
      state.input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: reminder }],
      })
    }
    return
  }

  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  let buffered: OpenAIInputContent[] = []
  const role = message.role
  const flush = () => {
    if (buffered.length === 0) return
    state.input.push({ type: 'message', role, content: buffered } as OpenAIInputMessage)
    buffered = []
  }

  for (const rawBlock of content) {
    const block = rawBlock as AnthropicRequestContentBlock
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      buffered.push({
        type: role === AnthropicMessageRole.Assistant ? 'output_text' : 'input_text',
        text: block.text,
      })
      continue
    }
    if (block.type === 'image' && 'source' in block) {
      const imageUrl = imageDataUrl(block.source)
      if (imageUrl !== undefined) buffered.push({ type: 'input_image', image_url: imageUrl })
      continue
    }
    if (block.type === 'document' && 'source' in block && isJsonObject(block.source)) {
      const source = block.source
      const data =
        typeof source.data === 'string'
          ? source.data
          : typeof source.base64 === 'string'
            ? source.base64
            : undefined
      if (
        source.type === 'base64' &&
        typeof source.media_type === 'string' &&
        source.media_type.toLowerCase() === 'application/pdf' &&
        data
      ) {
        buffered.push({
          type: 'input_file',
          file_data: `data:${source.media_type};base64,${data}`,
          filename: 'document.pdf',
        })
      }
      continue
    }
    if (
      block.type === 'thinking' &&
      role === AnthropicMessageRole.Assistant &&
      'signature' in block &&
      typeof block.signature === 'string'
    ) {
      const signature = compatibleReasoningSignature(block.signature)
      if (signature !== undefined) {
        flush()
        state.input.push({
          type: 'reasoning',
          summary: [],
          content: null,
          encrypted_content: signature,
        })
      }
      continue
    }
    if (
      block.type === 'tool_use' &&
      'id' in block &&
      typeof block.id === 'string' &&
      'name' in block &&
      typeof block.name === 'string'
    ) {
      flush()
      state.input.push({
        type: 'function_call',
        call_id: mapCallId(block.id, state.callIds, state.originalCallIds),
        name: state.toolNames.get(block.name) ?? shortenToolName(block.name),
        arguments: JSON.stringify(isJsonObject(block.input) ? block.input : {}),
      })
      continue
    }
    if (
      block.type === 'tool_result' &&
      'tool_use_id' in block &&
      typeof block.tool_use_id === 'string'
    ) {
      flush()
      const toolResult = block as AnthropicToolResultBlock
      state.input.push({
        type: 'function_call_output',
        call_id: mapCallId(toolResult.tool_use_id, state.callIds, state.originalCallIds),
        output: toolResultOutput(toolResult),
      })
    }
  }
  flush()
}

/** Purely converts one Anthropic request into a stateless Responses request. */
export function transformAnthropicRequest(request: AnthropicMessageRequest) {
  const toolNamesInOrder = (request.tools ?? [])
    .filter((tool): tool is AnthropicFunctionTool => !isWebSearchTool(tool))
    .map((tool) => tool.name)
  const { toolNames, originalToolNames } = createToolNameMaps(toolNamesInOrder)
  const callIds = new Map<string, string>()
  const originalCallIds = new Map<string, string>()
  const input: OpenAIResponseInputItem[] = []
  const system = systemContents(request)
  if (system.length > 0) input.push({ type: 'message', role: 'developer', content: system })

  for (const message of request.messages) {
    transformMessage(message, { input, callIds, originalCallIds, toolNames })
  }

  const tools = request.tools?.map((tool) => transformTool(tool, toolNames))
  const transformed: OpenAIResponsesRequest = {
    model: request.model,
    instructions: '',
    input,
    tools,
    tool_choice:
      request.tools === undefined
        ? undefined
        : transformToolChoice(request.tool_choice, request.tools, toolNames),
    parallel_tool_calls: request.tool_choice?.disable_parallel_tool_use !== true,
    reasoning: {
      effort: reasoningEffort(request.thinking, request.output_config?.effort),
      summary:
        request.thinking?.type !== 'disabled' && request.thinking?.display === 'summarized'
          ? 'auto'
          : undefined,
    },
    service_tier:
      request.service_tier?.toLowerCase().trim() === 'priority' ||
      request.service_tier?.toLowerCase().trim() === 'fast' ||
      request.speed === 'fast'
        ? 'priority'
        : undefined,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  }
  const context: ResponseTransformContext = {
    toolNames,
    originalToolNames,
    callIds,
    originalCallIds,
  }
  return { request: transformed, context }
}
