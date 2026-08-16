import { createHash } from 'node:crypto'
import type {
  OpenAIFunctionCallInputItem,
  OpenAIReasoningInputItem,
  OpenAIResponseInputItem,
} from '../../protocol/openai-responses'
import type { CodexExecutionScope } from './client'

/** Typed upstream items safe to replay into later stateless requests. */
export type ReasoningReplayItem = OpenAIReasoningInputItem | OpenAIFunctionCallInputItem

/** One atomically committed successful assistant turn. */
export interface ReasoningReplayTurn {
  /** Stable deduplication marker. */
  id: string
  /** Fingerprint of the translated request prefix. */
  requestFingerprint: string
  /** Fingerprint of the assistant replay items. */
  assistantFingerprint: string
  /** Function IDs resolved by a later full-history request. */
  callIds: string[]
  /** Immutable reasoning and call items. */
  items: ReasoningReplayItem[]
}

interface StoredTurn extends ReasoningReplayTurn {
  lastMatched: number
}

interface StoredScope {
  turns: Map<string, StoredTurn>
  lastUsed: number
}

/** Builds the isolation key for one Claude root or subagent. */
export function replayScopeKey(scope: CodexExecutionScope) {
  return `${scope.sessionId}\0${scope.agentId}\0${scope.model}`
}

/** Deterministically fingerprints typed replay state. */
export function replayFingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Bounded process-lifetime reasoning replay storage. */
export class ReasoningReplayStore {
  private scopes = new Map<string, StoredScope>()
  private clock = 0

  /** Replays matching, absent items for full-history tool loops. */
  replay(scope: CodexExecutionScope, input: OpenAIResponseInputItem[]) {
    const stored = this.scopes.get(replayScopeKey(scope))
    if (stored === undefined) return input
    stored.lastUsed = ++this.clock
    const outputs = new Set(
      input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    )
    const existing = new Set(
      input.flatMap((item) => {
        if (item.type === 'reasoning') return [`reasoning:${item.encrypted_content}`]
        if (item.type === 'function_call') return [`call:${item.call_id}`]
        return []
      }),
    )
    const replay: ReasoningReplayItem[] = []
    for (const turn of stored.turns.values()) {
      if (turn.callIds.length > 0 && !turn.callIds.some((id) => outputs.has(id))) continue
      let matched = false
      for (const item of turn.items) {
        const key =
          item.type === 'reasoning' ? `reasoning:${item.encrypted_content}` : `call:${item.call_id}`
        if (existing.has(key)) continue
        replay.push(structuredClone(item))
        existing.add(key)
        matched = true
      }
      if (matched) turn.lastMatched = ++this.clock
    }
    if (replay.length === 0) return input
    const firstOutput = input.findIndex((item) => item.type === 'function_call_output')
    const insertion = firstOutput < 0 ? input.length : firstOutput
    return [...input.slice(0, insertion), ...replay, ...input.slice(insertion)]
  }

  /** Atomically commits one successful turn, skipping oversized or duplicate turns. */
  commit(scope: CodexExecutionScope, turn: ReasoningReplayTurn) {
    if (turn.items.length > 128) return
    const key = replayScopeKey(scope)
    let stored = this.scopes.get(key)
    if (stored === undefined) {
      stored = { turns: new Map(), lastUsed: ++this.clock }
      this.scopes.set(key, stored)
    }
    stored.lastUsed = ++this.clock
    if (stored.turns.has(turn.id)) return
    stored.turns.set(turn.id, { ...structuredClone(turn), lastMatched: ++this.clock })
    while (stored.turns.size > 256) this.evictTurn(stored)
    while (this.totalTurns() > 2048) this.evictGlobalTurn()
    while (this.scopes.size > 64) this.evictScope()
  }

  /** Clears only one failed reasoning scope. */
  clearScope(scope: CodexExecutionScope) {
    this.scopes.delete(replayScopeKey(scope))
  }

  /** Releases every process-lifetime replay turn. */
  clear() {
    this.scopes.clear()
  }

  private totalTurns() {
    let count = 0
    for (const scope of this.scopes.values()) count += scope.turns.size
    return count
  }

  private evictTurn(scope: StoredScope) {
    const ordered = [...scope.turns.values()].sort((left, right) => {
      const leftUnresolved = left.callIds.length > 0 ? 1 : 0
      const rightUnresolved = right.callIds.length > 0 ? 1 : 0
      return leftUnresolved - rightUnresolved || left.lastMatched - right.lastMatched
    })
    if (ordered[0] !== undefined) scope.turns.delete(ordered[0].id)
  }

  private evictGlobalTurn() {
    const scopes = [...this.scopes.values()].sort((left, right) => left.lastUsed - right.lastUsed)
    if (scopes[0] !== undefined) this.evictTurn(scopes[0])
  }

  private evictScope() {
    const entry = [...this.scopes.entries()].sort(
      ([, left], [, right]) => left.lastUsed - right.lastUsed,
    )[0]
    if (entry !== undefined) this.scopes.delete(entry[0])
  }
}
