import * as v from 'valibot'

const EffortLevelSchema = v.picklist(['low', 'medium', 'high', 'xhigh', 'max'])

const ConfigSchema = v.object({
  id: v.string(),
  models: v.optional(
    v.union([
      v.object({
        default: v.optional(v.string()),
        subagent: v.optional(v.string()),
        haiku: v.optional(v.string()),
        sonnet: v.optional(v.string()),
        opus: v.optional(v.string()),
      }),
      v.pipe(
        v.string(),
        v.transform((model) => ({
          default: model,
          subagent: model,
          haiku: model,
          sonnet: model,
          opus: model,
        })),
      ),
    ]),
  ),
  thinking: v.optional(
    v.object({
      effort: v.optional(EffortLevelSchema),
    }),
  ),
  // When omitted, the official Claude subscription auth is used as-is
  // (no base URL or auth token override).
  api: v.optional(v.pipe(v.string(), v.url())),
  apiKey: v.optional(v.string()),
  default: v.optional(v.boolean()),
  args: v.optional(v.array(v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  settings: v.optional(v.record(v.string(), v.unknown())),
})

const ConfigListSchema = v.array(ConfigSchema)

const ConfigListFileSchema = v.pipe(v.string(), v.parseJson(), ConfigListSchema)

export type Config = v.InferOutput<typeof ConfigSchema>
export type ConfigList = v.InferOutput<typeof ConfigListSchema>

export function parse(raw: string) {
  const parsed = v.safeParse(ConfigListFileSchema, raw)
  if (parsed.success) {
    return {
      success: true,
      list: parsed.output,
    } as const
  }
  return {
    success: false,
    error: v.summarize(parsed.issues),
  } as const
}
