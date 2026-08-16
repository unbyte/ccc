/** Reversible state shared by request and response transformation. */
export interface ResponseTransformContext {
  /** Original name to Responses-safe name. */
  toolNames: ReadonlyMap<string, string>
  /** Responses-safe name to original name. */
  originalToolNames: ReadonlyMap<string, string>
  /** Original call ID to Responses-safe call ID. */
  callIds: ReadonlyMap<string, string>
  /** Responses-safe call ID to original call ID. */
  originalCallIds: ReadonlyMap<string, string>
}
