import type { ServerResponse } from 'node:http'
import { transformError } from './anthropic'

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, transformError(status, message))
}
