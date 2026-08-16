/** A JSON value accepted on either protocol wire. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** The object form used for JSON Schema tool inputs. */
export type JsonSchema = Record<string, JsonValue>

/** Returns whether a decoded JSON value is a non-array object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
