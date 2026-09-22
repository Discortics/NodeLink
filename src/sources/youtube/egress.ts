import { ProxyAgent, fetch as undiciFetch } from 'undici'
import type { HttpProxyConfig } from '../../typings/utils.types.ts'
import { logger } from '../../utils.ts'

export type YouTubeProxyMode = 'off' | 'control' | 'all'
export type YouTubeRequestClass = 'control' | 'media' | 'internal'

const agents = new Map<string, ProxyAgent>()

export function shouldProxyYouTube(
  mode: YouTubeProxyMode | undefined,
  requestClass: YouTubeRequestClass
): boolean {
  if (requestClass === 'internal' || mode === 'off') return false
  return requestClass === 'control' || (mode ?? 'all') === 'all'
}

export function logYouTubeEgress(
  operation: string,
  requestClass: YouTubeRequestClass,
  proxy: HttpProxyConfig | boolean | undefined,
  status: number | string,
  durationMs: number,
  detail = ''
): void {
  logger(
    'debug',
    'YouTubeRouting',
    `egress operation=${operation} class=${requestClass} route=${proxy ? 'proxy' : 'direct'} status=${status} durationMs=${durationMs}${detail ? ` ${detail}` : ''}`
  )
}

function agentFor(proxy: HttpProxyConfig): ProxyAgent {
  if (!proxy.url || proxy.type === 'reverse') {
    throw new Error('A forward proxy URL is required for YouTube fetch.')
  }
  if (Boolean(proxy.username) !== Boolean(proxy.password)) {
    throw new Error(
      'YouTube proxy username and password must be supplied together.'
    )
  }
  const key = `${proxy.url}\u0000${proxy.username ?? ''}\u0000${proxy.password ?? ''}`
  let agent = agents.get(key)
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxy.url,
      ...(proxy.username && proxy.password
        ? {
            token: `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
          }
        : {})
    })
    agents.set(key, agent)
  }
  return agent
}

/** A per-request proxy path for the YouTube native-fetch call sites. */
export async function youtubeFetch(
  url: string,
  init: RequestInit = {},
  proxy?: HttpProxyConfig,
  operation = 'fetch',
  requestClass: YouTubeRequestClass = 'control'
): Promise<Response> {
  const start = Date.now()
  try {
    const response = proxy
      ? await undiciFetch(url, {
          ...(init as Parameters<typeof undiciFetch>[1]),
          dispatcher: agentFor(proxy)
        })
      : await fetch(url, init)
    logYouTubeEgress(
      operation,
      requestClass,
      proxy,
      response.status,
      Date.now() - start
    )
    return response as Response
  } catch (error) {
    logYouTubeEgress(
      operation,
      requestClass,
      proxy,
      'error',
      Date.now() - start
    )
    throw error
  }
}
