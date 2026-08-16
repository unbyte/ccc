import type { AnthropicModelListResponse } from '../../protocol/anthropic-messages'

/** Validates and freezes caller-supplied model IDs. */
export function validateModels(models: readonly string[]) {
  if (models.length === 0) throw new Error('At least one model ID is required')
  const seen = new Set<string>()
  return models.map((model) => {
    if (!model.trim()) throw new Error('Model IDs must be non-empty strings')
    if (seen.has(model)) throw new Error(`Duplicate model ID: ${model}`)
    seen.add(model)
    return model
  })
}

/** Synthesizes Anthropic model-list entries without model discovery or aliasing. */
export function createModelList(models: readonly string[]): AnthropicModelListResponse {
  const validated = validateModels(models)
  return {
    data: validated.map((id) => ({
      type: 'model',
      id,
      display_name: id,
      created_at: new Date(0).toISOString(),
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null,
    })),
    has_more: false,
    first_id: validated[0],
    last_id: validated.at(-1) as string,
  }
}
