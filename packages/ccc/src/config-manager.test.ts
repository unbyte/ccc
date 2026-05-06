import { vol } from 'memfs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigList } from './config'
import { LoadError, load, pick } from './config-manager'

vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs')
  return memfs.fs.promises
})

describe('load', () => {
  afterEach(() => {
    vol.reset()
  })

  it('creates config file with empty array if not exists', async () => {
    await expect(load('/home/config.json')).rejects.toThrow(LoadError)
    expect(vol.readFileSync('/home/config.json', 'utf-8')).toBe('[]')
  })

  it('loads a valid config file', async () => {
    vol.fromJSON({ '/home/config.json': JSON.stringify([{ id: 'test', api: 'https://api.example.com' }]) })
    const result = await load('/home/config.json')
    expect(result).toHaveLength(1)
  })

  it('throws on invalid JSON', async () => {
    vol.fromJSON({ '/home/config.json': 'not json' })
    await expect(load('/home/config.json')).rejects.toThrow(LoadError)
  })

  it('throws on invalid schema', async () => {
    vol.fromJSON({ '/home/config.json': JSON.stringify([{ id: 123 }]) })
    await expect(load('/home/config.json')).rejects.toThrow(LoadError)
  })

  it('throws on empty config list', async () => {
    vol.fromJSON({ '/home/config.json': '[]' })
    await expect(load('/home/config.json')).rejects.toThrow(LoadError)
  })

  it('throws on multiple default configs', async () => {
    const configs = [
      { id: 'a', api: 'https://a.com', default: true },
      { id: 'b', api: 'https://b.com', default: true },
    ]
    vol.fromJSON({ '/home/config.json': JSON.stringify(configs) })
    await expect(load('/home/config.json')).rejects.toThrow(LoadError)
  })

  it('allows a single default config', async () => {
    const configs = [
      { id: 'a', api: 'https://a.com', default: true },
      { id: 'b', api: 'https://b.com' },
    ]
    vol.fromJSON({ '/home/config.json': JSON.stringify(configs) })
    const result = await load('/home/config.json')
    expect(result).toHaveLength(2)
  })
})

describe('pick', () => {
  const list: ConfigList = [
    { id: 'first', api: 'https://first.com' },
    { id: 'second', api: 'https://second.com', default: true },
    { id: 'third', api: 'https://third.com' },
  ]

  it('returns the default config when no id is given', () => {
    expect(pick(list)).toEqual(list[1])
  })

  it('returns the first config if no default is set', () => {
    const noDefault: ConfigList = [
      { id: 'a', api: 'https://a.com' },
      { id: 'b', api: 'https://b.com' },
    ]
    expect(pick(noDefault)).toEqual(noDefault[0])
  })

  it('returns the config matching the given id', () => {
    expect(pick(list, 'third')).toEqual(list[2])
  })

  it('returns undefined for a non-existent id', () => {
    expect(pick(list, 'nope')).toBeUndefined()
  })
})
