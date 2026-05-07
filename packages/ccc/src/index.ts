#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config'
import { load, pick } from './config-manager'

const CONFIG_FILE = join(homedir(), '.ccc', 'config.json')

function run(config: Config, _args: string[]) {
  const args = [..._args]
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_BASE_URL: config.api,
    ANTHROPIC_AUTH_TOKEN: config.apiKey || 'no-auth',
  }

  if (config.args?.length) {
    args.unshift(...config.args)
  }

  if (config.models) {
    const { models } = config
    if (models.default) env.ANTHROPIC_MODEL = models.default
    if (models.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = models.subagent
    if (models.haiku) {
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = models.haiku
      env.ANTHROPIC_SMALL_FAST_MODEL = models.haiku
    }
    if (models.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = models.sonnet
    if (models.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = models.opus
  }

  if (config.thinking) {
    const { thinking } = config
    if (thinking.effort) env.CLAUDE_CODE_EFFORT_LEVEL = thinking.effort
  }

  if (config.env) {
    Object.assign(env, config.env)
  }

  if (config.settings) {
    args.unshift('--settings', JSON.stringify(config.settings))
  }

  console.log('🚀 config:', config.id)

  spawn('claude', args, {
    env,
    stdio: 'inherit',
  })
    .on('error', (error) => {
      console.error('failed to start claude code:')
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
    .on('close', (code) => {
      process.exit(code ?? 0)
    })
}

async function main() {
  const args = process.argv.slice(2)
  const list = await load(CONFIG_FILE)

  let config: Config | undefined
  let runArgs: string[] = []

  // try to interpret the first arg as a config id
  if (args[0]) {
    config = pick(list, args[0])
    runArgs = args.slice(1)
  }

  // if no config matched, pass all args through to claude code
  // and use the default config
  if (config == null) {
    config = pick(list)
    runArgs = args
  }

  run(config, runArgs)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
