/**
 * dsh-antidsh-mcp — a Cordis plugin that exposes the live dsh session control
 * plane to external MCP clients, inside the same process as `dsh web`.
 *
 * The plugin owns one exact HTTP route on dsh's web server. It registers the
 * route as anonymous because the web server's authentication admits dsh web
 * peers, not the separate Bearer token external MCP clients carry; this plugin
 * performs its own token, Origin, and Host checks (see `http.js`).
 *
 * Loading it does not start any background work: the route is registered in a
 * Cordis effect and removed when the plugin is disposed (profile reload, HMR
 * patch edit, or process shutdown).
 */

import z from '@deepseek-ai/schemastery'

import { createMcpHandler, DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from './http.js'
import { INSTRUCTIONS, SERVER_INFO } from './protocol.js'
import { resolveToken } from './security.js'
import { createTools } from './tools/index.js'

export const name = 'dsh-antidsh-mcp'

export const Config = z.object({
  path: z
    .string()
    .default('/antidsh/mcp')
    .description('Absolute HTTP path of the MCP endpoint on the dsh web server.'),
  token: z
    .string()
    .default('')
    .description('Bearer token MCP clients must present. Empty falls back to ANTIDSH_MCP_TOKEN.'),
  allowUnauthenticatedLoopback: z
    .boolean()
    .default(false)
    .description('Development only: when no token is configured, accept requests from loopback peers.'),
  defaultWaitMs: z
    .number()
    .min(0)
    .max(25_000)
    .default(0)
    .description('Default short wait used by dsh_send when wait_ms is omitted (0 means do not wait).'),
})

export const inject = ['webServer', 'sessionController']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path: string, token: string, allowUnauthenticatedLoopback: boolean, defaultWaitMs: number }} config
 * @returns {void}
 */
export function apply(ctx, config) {
  const token = resolveToken(config.token, process.env.ANTIDSH_MCP_TOKEN)
  const allowUnauthenticatedLoopback = config.allowUnauthenticatedLoopback === true
  const routePath = normalizeRoutePath(config.path)
  const allowedHostnames = collectHostnames(ctx.webServer)
  const logger = createLogger(ctx)

  const handler = createMcpHandler({
    tools: createTools(ctx.sessionController, { defaultWaitMs: config.defaultWaitMs }),
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    security: { token, allowUnauthenticatedLoopback, allowedHostnames },
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    bodyTimeoutMs: DEFAULT_BODY_TIMEOUT_MS,
    logger,
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      auth: 'anonymous',
      handler,
    }),
    `dsh-antidsh-mcp: ${routePath} MCP route`,
  )

  reportReadiness(ctx, { routePath, token, allowUnauthenticatedLoopback, logger })
}

/**
 * Normalize a configured route path to the absolute, slash-free form the web
 * server's exact router expects.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRoutePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  let path = raw.length === 0 ? '/antidsh/mcp' : raw
  if (!path.startsWith('/')) path = `/${path}`
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * Host authorities this listener may legitimately be addressed by in addition
 * to loopback. The web server only listens on a concrete local address, so the
 * bind address is the only non-loopback value accepted; DNS names are never
 * trusted.
 *
 * @param {import('@deepseek-ai/cordis').Context['webServer']} webServer
 * @returns {string[]}
 */
function collectHostnames(webServer) {
  /** @type {string[]} */
  const names = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !names.includes(value)) names.push(value)
  }

  try {
    push(webServer.host)
  } catch {
    // The service may not be bound yet; loopback still works without it.
  }
  try {
    push(new URL(webServer.getOrigin()).hostname)
  } catch {
    // `getOrigin()` throws until the listener has a port.
  }
  return names
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }}
 */
function createLogger(ctx) {
  return {
    info: (...args) => {
      if (ctx.logger?.info !== undefined) ctx.logger.info(...args)
      else console.info(...args)
    },
    warn: (...args) => {
      if (ctx.logger?.warn !== undefined) ctx.logger.warn(...args)
      else console.warn(...args)
    },
    error: (...args) => {
      if (ctx.logger?.error !== undefined) ctx.logger.error(...args)
      else console.error(...args)
    },
  }
}

/**
 * Print the endpoint and its authentication posture once at startup so the
 * operator can copy the URL into an MCP client without reading the config.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ routePath: string, token: string | null, allowUnauthenticatedLoopback: boolean, logger: ReturnType<typeof createLogger> }} state
 * @returns {void}
 */
function reportReadiness(ctx, state) {
  const { routePath, token, allowUnauthenticatedLoopback, logger } = state
  let origin = 'this dsh web origin (listener not bound yet)'
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    // Startup logging is best-effort; the route still registers.
  }

  logger.info(`[antidsh-mcp] MCP endpoint: ${origin}${routePath}`)
  if (token !== null) {
    logger.info('[antidsh-mcp] Bearer authentication is required.')
    return
  }
  if (allowUnauthenticatedLoopback) {
    logger.warn(
      '[antidsh-mcp] no token configured; unauthenticated loopback access is enabled. '
      + 'Any local process can drive this dsh instance. Keep the listener bound to loopback.',
    )
    return
  }
  logger.warn(
    '[antidsh-mcp] no token configured: every MCP request will be refused with 503. '
    + 'Set the plugin option "token" (or ANTIDSH_MCP_TOKEN) and restart dsh web.',
  )
}
