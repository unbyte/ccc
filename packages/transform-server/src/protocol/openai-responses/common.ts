import type { JsonValue } from '../json'

/** Text used as model input. */
export interface OpenAIInputText {
  /** Input-text discriminator. */
  type: 'input_text'
  /** Literal text. */
  text: string
}

/** Historical assistant text. */
export interface OpenAIOutputText {
  /** Output-text discriminator. */
  type: 'output_text'
  /** Generated text. */
  text: string
  /** Optional response annotations. */
  annotations?: JsonValue[]
}

/** Inline image sent as a data URL. */
export interface OpenAIInputImage {
  /** Input-image discriminator. */
  type: 'input_image'
  /** Inline data URL. */
  image_url: string
}

/** Inline file input. */
export interface OpenAIInputFile {
  /** Input-file discriminator. */
  type: 'input_file'
  /** Inline data URL. */
  file_data: string
  /** Synthetic upload filename. */
  filename: string
}

/** Content inside a Responses input message. */
export type OpenAIInputContent =
  | OpenAIInputText
  | OpenAIOutputText
  | OpenAIInputImage
  | OpenAIInputFile

/** A reasoning summary or fallback reasoning text part. */
export interface OpenAIReasoningTextPart {
  /** Upstream part discriminator. */
  type?: string
  /** User-visible summarized reasoning. */
  text: string
}
