import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isJsonObject } from '../../protocol/json'
import { AdaptorError } from '../shared/errors'

// CLIProxyAPI refreshes expiring tokens with a single-flight operation, persists rotations,
// and retries eligible failures. This local adaptor intentionally stops at the read-only Codex
// CLI credential-file boundary; `codex login` owns acquisition, refresh, and persistence.

/** OAuth values used to authenticate with the Codex backend. */
export interface CodexCredential {
  /** Current bearer token. */
  accessToken: string
  /** ChatGPT account identifier. */
  accountId?: string
}

/** Reads the current Codex CLI credential without retaining sensitive values. */
export async function loadCodexCredential() {
  const path = join(homedir(), '.codex', 'auth.json')
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new AdaptorError(
      'Codex credentials are unavailable. Run `codex login` and retry.',
      401,
      'authentication_error',
    )
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new AdaptorError(
      'Codex credentials are malformed. Run `codex login` and retry.',
      401,
      'authentication_error',
    )
  }
  if (!isJsonObject(decoded) || !isJsonObject(decoded.tokens)) {
    throw new AdaptorError(
      'Codex credentials have an unsupported shape. Run `codex login` and retry.',
      401,
      'authentication_error',
    )
  }
  const accessToken = decoded.tokens.access_token
  const accountId = decoded.tokens.account_id
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new AdaptorError(
      'Codex credentials contain no usable access token. Run `codex login` and retry.',
      401,
      'authentication_error',
    )
  }
  return {
    accessToken,
    accountId: typeof accountId === 'string' && accountId ? accountId : undefined,
  }
}
