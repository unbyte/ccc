import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function configPath() {
  const xdg = process.env.XDG_CONFIG_HOME
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(configHome, 'ccc', 'config.json')
}
