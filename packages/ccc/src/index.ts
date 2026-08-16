#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createServer, type TransformServer } from '../../transform-server/src'
import type { Config, TransformConfig } from './config'
import { load, pick } from './config-manager'
import { configPath } from './paths'

function createTransformServer(transform: TransformConfig, models: Config['models']) {
  const modelIds = [
    ...new Set(Object.values(models ?? {}).filter((model): model is string => model !== undefined)),
  ]
  return createServer({
    adaptor: {
      ...transform,
      models: modelIds,
    },
  })
}

async function run(config: Config, _args: string[]) {
  const args = [..._args]
  const env: Record<string, string | undefined> = {
    ...process.env,
  }

  let transformServer: TransformServer | undefined
  if (config.transform) {
    transformServer = await createTransformServer(config.transform, config.models)
    env.ANTHROPIC_BASE_URL = transformServer.url
    env.ANTHROPIC_AUTH_TOKEN = 'no-auth'
  } else if (config.api) {
    env.ANTHROPIC_BASE_URL = config.api
    env.ANTHROPIC_AUTH_TOKEN = config.apiKey || 'no-auth'
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
    .on('error', async (error) => {
      await transformServer?.close()
      console.error('failed to start claude code:')
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
    .on('close', async (code) => {
      await transformServer?.close()
      process.exit(code ?? 0)
    })
}

async function main() {
  const args = process.argv.slice(2)
  const list = await load(configPath())

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

  await run(config, runArgs)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
