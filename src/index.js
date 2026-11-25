/**
 * dsh-antidsh-mcp — a Cordis plugin that exposes the live dsh session control
 * plane to external MCP clients, inside the same process as `dsh Desktop` /
 * `dsh web`.
 *
 * The plugin owns one exact HTTP route on dsh's web server. It registers the
 * route as anonymous because the web server's authentication admits dsh web
 * peers, not the separate Bearer token external MCP clients carry; this plugin
 * performs its own token, Origin, and Host checks (see `http.js`).
 *
 * Out of the box (`autoToken: true`, `publishRuntimeFile: true`), the plugin
 * generates and persists a random local Bearer token under
 * `<DSH_HOME>/antidsh-token` and publishes the live endpoint URL + token to
 * `<DSH_HOME>/antidsh-runtime.json` so zero-config local clients (such as the
 * bundled Antigravity plugin) work across `dsh Desktop` restarts and random
 * port assignments without manual config edits.
 */

import z from '@deepseek-ai/schemastery'

import { createMcpHandler, DEFAULT_BODY_TIMEOUT_MS, DEFAULT_MAX_BODY_BYTES } from './http.js'
import { INSTRUCTIONS, SERVER_INFO } from './protocol.js'
import { loadOrCreateAutoToken, publishRuntimeDiscovery } from './runtime.js'
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
    .description('Bearer token MCP clients must present. Empty falls back to ANTIDSH_MCP_TOKEN, then autoToken.'),
  autoToken: z
    .boolean()
    .default(true)
    .description('Automatically generate and persist a local Bearer token in <DSH_HOME>/antidsh-token when no explicit token is set.'),
  publishRuntimeFile: z
    .boolean()
    .default(true)
    .description('Write the live endpoint URL and token to <DSH_HOME>/antidsh-runtime.json for zero-config local MCP clients.'),
  allowUnauthenticatedLoopback: z
    .boolean()
    .default(false)
    .description('Development only: when no explicit token is configured, accept requests from loopback peers.'),
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
 * @param {{
 *   path: string,
 *   token: string,
 *   autoToken: boolean,
 *   publishRuntimeFile: boolean,
 *   allowUnauthenticatedLoopback: boolean,
 *   defaultWaitMs: number,
 * }} config
 * @returns {void}
 */
export function apply(ctx, config) {
  const allowUnauthenticatedLoopback = config.allowUnauthenticatedLoopback === true
  const autoToken = config.autoToken !== false
  const publishRuntimeFile = config.publishRuntimeFile !== false
  const routePath = normalizeRoutePath(config.path)
  const allowedHostnames = collectHostnames(ctx.webServer)
  const logger = createLogger(ctx)

  const resolvedAuth = resolveEffectiveToken({
    configToken: config.token,
    envToken: process.env.ANTIDSH_MCP_TOKEN,
    autoToken,
    allowUnauthenticatedLoopback,
    logger,
  })
  const token = resolvedAuth.token

  const handler = createMcpHandler({
    tools: createTools(ctx.sessionController, { defaultWaitMs: config.defaultWaitMs }),
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    security: { token, allowUnauthenticatedLoopback, allowedHostnames },
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    bodyTimeoutMs: DEFAULT_BODY_TIMEOUT_MS,
    logger,
  })

  const origin = readOrigin(ctx.webServer)
  let runtimeFile = null

  ctx.effect(
    () => {
      const unregister = ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        auth: 'anonymous',
        handler,
      })

      let runtimeDisposer = null
      if (publishRuntimeFile && origin !== null) {
        try {
          const authMode = token !== null
            ? 'bearer'
            : (allowUnauthenticatedLoopback ? 'unauthenticated-loopback' : 'unconfigured')
          const published = publishRuntimeDiscovery({
            origin,
            path: routePath,
            token,
            auth: authMode,
          })
          runtimeFile = published.filePath
          runtimeDisposer = published.dispose
        } catch (error) {
          logger.warn('[antidsh-mcp] failed to write runtime discovery file:', error)
        }
      }

      return () => {
        runtimeDisposer?.()
        unregister?.()
      }
    },
    `dsh-antidsh-mcp: ${routePath} MCP route`,
  )

  reportReadiness({
    origin,
    routePath,
    token,
    tokenSource: resolvedAuth.source,
    tokenFile: resolvedAuth.filePath,
    runtimeFile,
    allowUnauthenticatedLoopback,
    logger,
  })
}

/**
 * Resolve the effective Bearer token according to precedence:
 *   1. explicit `config.token`
 *   2. explicit `ANTIDSH_MCP_TOKEN` environment variable
 *   3. `allowUnauthenticatedLoopback` (no token)
 *   4. persisted auto-generated token in `<DSH_HOME>/antidsh-token` (when `autoToken` is true)
 *   5. `null` (fail-closed 503)
 *
 * @param {{
 *   configToken: unknown,
 *   envToken: unknown,
 *   autoToken: boolean,
 *   allowUnauthenticatedLoopback: boolean,
 *   logger: ReturnType<typeof createLogger>,
 * }} options
 * @returns {{ token: string | null, source: 'configured' | 'auto' | 'loopback' | 'unconfigured', filePath: string | null }}
 */
function resolveEffectiveToken(options) {
  const explicit = resolveToken(options.configToken, options.envToken)
  if (explicit !== null) {
    return { token: explicit, source: 'configured', filePath: null }
  }
  if (options.allowUnauthenticatedLoopback) {
    return { token: null, source: 'loopback', filePath: null }
  }
  if (options.autoToken) {
    try {
      const loaded = loadOrCreateAutoToken()
      return { token: loaded.token, source: 'auto', filePath: loaded.filePath }
    } catch (error) {
      options.logger.warn('[antidsh-mcp] failed to initialize auto-generated token; failing closed:', error)
    }
  }
  return { token: null, source: 'unconfigured', filePath: null }
}

/**
 * @param {import('@deepseek-ai/cordis').Context['webServer']} webServer
 * @returns {string | null}
 */
function readOrigin(webServer) {
  try {
    const origin = webServer.getOrigin()
    return typeof origin === 'string' && origin.length > 0 ? origin : null
  } catch {
    return null
  }
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
 * Print the endpoint, authentication posture, and discovery file path once at startup.
 *
 * @param {{
 *   origin: string | null,
 *   routePath: string,
 *   token: string | null,
 *   tokenSource: 'configured' | 'auto' | 'loopback' | 'unconfigured',
 *   tokenFile: string | null,
 *   runtimeFile: string | null,
 *   allowUnauthenticatedLoopback: boolean,
 *   logger: ReturnType<typeof createLogger>,
 * }} state
 * @returns {void}
 */
function reportReadiness(state) {
  const { origin, routePath, token, tokenSource, tokenFile, runtimeFile, allowUnauthenticatedLoopback, logger } = state
  const displayOrigin = origin ?? 'this dsh web origin (listener not bound yet)'

  logger.info(`[antidsh-mcp] MCP endpoint: ${displayOrigin}${routePath}`)
  if (runtimeFile !== null) {
    logger.info(`[antidsh-mcp] Runtime discovery file: ${runtimeFile}`)
  }

  if (token !== null) {
    if (tokenSource === 'auto' && tokenFile !== null) {
      logger.info(`[antidsh-mcp] Bearer authentication is required (auto-generated token persisted at ${tokenFile}).`)
    } else {
      logger.info('[antidsh-mcp] Bearer authentication is required.')
    }
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
    + 'Set the plugin option "token" (or ANTIDSH_MCP_TOKEN) or enable autoToken and restart dsh.',
  )
}
