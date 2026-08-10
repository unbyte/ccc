import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Config, type ConfigList, parse } from './config'

export class LoadError extends Error {
  constructor(lines: string[], configFile: string) {
    super([...lines, `please fix the config file at ${configFile}`].join('\n'))
    this.name = 'LoadError'
  }
}

async function exists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function load(configFile: string) {
  let content: string
  try {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
    if (!(await exists(configFile))) {
      await writeFile(configFile, '[]', 'utf-8')
    }

    content = await readFile(configFile, 'utf-8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new LoadError(['failed to load config file:', detail], configFile)
  }

  const parsed = parse(content)

  if (!parsed.success) {
    throw new LoadError(['invalid config file format:', parsed.error], configFile)
  }

  const { list } = parsed

  // Validated here instead of in valibot pipes for clearer error messages

  if (list.length === 0) {
    throw new LoadError(['config file is empty.'], configFile)
  }

  const defaults = list.filter((config) => config.default)
  if (defaults.length > 1) {
    const message = ['multiple default configs found:']
    for (const config of defaults) {
      message.push(`- ${config.id}`)
    }
    throw new LoadError(message, configFile)
  }

  return list
}

export function pick(list: ConfigList): Config
export function pick(list: ConfigList, id: string): Config | undefined
export function pick(list: ConfigList, id?: string) {
  if (id == null) {
    return list.find((config) => config.default) ?? list[0]
  }
  return list.find((config) => config.id === id)
}
