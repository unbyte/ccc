/** Maps Anthropic thinking controls to Responses reasoning effort. */
export function reasoningEffort(
  thinking?: { type: string; budget_tokens?: number },
  explicitEffort?: string,
) {
  if (thinking?.type === 'disabled') return 'none'
  if (thinking?.type === 'adaptive' || thinking?.type === 'auto') {
    return explicitEffort?.trim().toLowerCase() || 'xhigh'
  }
  if (thinking?.type !== 'enabled' || thinking.budget_tokens === undefined) return 'medium'

  const budget = thinking.budget_tokens
  if (budget < 0) return 'medium'
  if (budget === 0) return 'none'
  if (budget <= 512) return 'minimal'
  if (budget <= 1024) return 'low'
  if (budget <= 8192) return 'medium'
  if (budget <= 24576) return 'high'
  return 'xhigh'
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return undefined
  try {
    return Buffer.from(value, 'base64url')
  } catch {
    return undefined
  }
}

/** Returns provider-native encrypted reasoning only for a GPT/Codex envelope. */
export function compatibleReasoningSignature(rawSignature: string) {
  const trimmed = rawSignature.trim()
  const separator = trimmed.indexOf('#')
  const prefix = separator >= 0 ? trimmed.slice(0, separator).toLowerCase() : undefined
  const signature = separator >= 0 ? trimmed.slice(separator + 1).trim() : trimmed

  if (prefix !== undefined && !['openai', 'gpt', 'codex'].includes(prefix)) return undefined
  if (!signature.startsWith('gAAAA')) return undefined
  const decoded = decodeBase64Url(signature)
  if (decoded === undefined || decoded.length < 73 || decoded[0] !== 0x80) return undefined
  const ciphertextLength = decoded.length - 1 - 8 - 16 - 32
  if (ciphertextLength <= 0 || ciphertextLength % 16 !== 0) return undefined
  return signature
}
