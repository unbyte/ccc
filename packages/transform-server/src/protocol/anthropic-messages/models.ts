/** Optional local model-list query accepted for protocol compatibility. */
export interface AnthropicModelListRequest {
  /** Return entries after this cursor; local lists do not paginate. */
  after_id?: string
  /** Return entries before this cursor; local lists do not paginate. */
  before_id?: string
  /** Requested page size; local lists return the configured set. */
  limit?: number
}

/** Model-list compatibility entry synthesized from caller configuration. */
export interface AnthropicModel {
  /** Model object discriminator. */
  type: 'model'
  /** Caller-supplied model ID. */
  id: string
  /** Display label, equal to the ID. */
  display_name: string
  /** Stable placeholder creation timestamp. */
  created_at: string
  /** Unknown compatibility metadata. */
  capabilities: null
  /** Unknown context capacity. */
  max_input_tokens: null
  /** Unknown output capacity. */
  max_tokens: null
}

/** Anthropic-compatible model list. */
export interface AnthropicModelListResponse {
  /** Synthesized models in caller order. */
  data: AnthropicModel[]
  /** Local lists never paginate. */
  has_more: false
  /** First configured model ID. */
  first_id: string
  /** Last configured model ID. */
  last_id: string
}
