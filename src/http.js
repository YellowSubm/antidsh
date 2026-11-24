/**
 * HTTP transport and security middleware for the antidsh MCP endpoint.
 *
 * The Streamable HTTP transport in MCP revision 2025-03-26 is a single POST
 * endpoint that answers with either a JSON-RPC response or 202 Accepted for
 * notifications. This server deliberately stays stateless and JSON-only: no
 * session id, no SSE stream, no resumability. That is legal for a server that
 * never sends unsolicited messages, and it keeps the endpoint debuggable with
 * curl.
 *
 * The route is registered with `auth: 'anonymous'` on dsh's web server because
 * authentication belongs to this plugin: dsh's web authentication knows
 * nothing about the MCP token, and the route must remain reachable by a native
 * MCP client that only carries `Authorization: Bearer`.
 *
 * Request handling order matters:
 *   1. Host        — reject DNS-rebinding authorities before any work.
 *   2. Origin      — reject non-loopback browser callers.
 *   3. Bearer      — fail closed when no token is configured.
 *   4. Method      — POST for RPC, DELETE for session termination, 405 else.
 *   5. Size/time   — a bounded body read with a hard timeout.
 *   6. Protocol    — JSON parse, version header, JSON-RPC dispatch.
 */

import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  handlePayload,
  isCompatibleProtocolVersion,
} from './protocol.js'
import {
  bearerToken,
  isCrossSiteRequest,
  isLoopbackPeer,
  isTrustedHost,
  isTrustedOrigin,
  secureEquals,
} from './security.js'

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
export const DEFAULT_BODY_TIMEOUT_MS = 10_000

/**
 * @typedef {object} McpHttpSecurity
 * @property {string | null} token resolved bearer token, or null when unconfigured
 * @property {boolean} [allowUnauthenticatedLoopback]
 * @property {string[]} [allowedHostnames]
 */

/**
 * @typedef {object} McpHttpOptions
 * @property {readonly import('./protocol.js').ToolDefinition[]} tools
 * @property {string} [instructions]
 * @property {{ name: string, version: string }} [serverInfo]
 * @property {McpHttpSecurity} security
 * @property {number} [maxBodyBytes]
 * @property {number} [bodyTimeoutMs]
 * @property {{ info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }} [logger]
 */

/**
 * @typedef {object} HttpBodyError
 * @property {'too-large' | 'timeout' | 'aborted'} code
 * @property {string} message
 */

class BodyReadError extends Error {
  /**
   * @param {'too-large' | 'timeout' | 'aborted'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'BodyReadError'
    this.code = code
  }
}

/**
 * Create the `(req, res) => Promise<void>` handler registered on the dsh web
 * server. The returned function never throws: transport failures become
 * JSON-RPC errors or a destroyed response, and internal defects are logged.
 *
 * @param {McpHttpOptions} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createMcpHandler(options) {
  const security = options.security
  const allowedHostnames = security.allowedHostnames ?? []
  const maxBodyBytes = positiveInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES)
  const bodyTimeoutMs = positiveInteger(options.bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS)
  const logger = options.logger ?? console
  const protocolOptions = {
    tools: options.tools,
    serverInfo: options.serverInfo,
    instructions: options.instructions,
  }

  let warnedUnconfigured = false
  let warnedUnauthenticated = false

  return async function handleMcpRequest(req, res) {
    try {
      if (!isTrustedHost(req, allowedHostnames)) {
        sendRpcError(res, 403, RpcErrorCode.INVALID_REQUEST, 'Host header is not a trusted loopback authority')
        return
      }
      if (isCrossSiteRequest(req)) {
        sendRpcError(res, 403, RpcErrorCode.INVALID_REQUEST, 'Cross-site browser requests are not allowed')
        return
      }
      if (!isTrustedOrigin(req)) {
        sendRpcError(res, 403, RpcErrorCode.INVALID_REQUEST, 'Origin must be a loopback origin')
        return
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'allow': 'POST, DELETE, OPTIONS',
          'cache-control': 'no-store',
          'content-length': '0',
        })
        res.end()
        return
      }

      const authorization = authorize(req, security)
      if (authorization === 'unconfigured') {
        if (!warnedUnconfigured) {
          warnedUnconfigured = true
          logger.warn(
            '[antidsh-mcp] no Bearer token configured: refusing every request with 503. '
            + 'Set the plugin option "token" (or ANTIDSH_MCP_TOKEN) and restart dsh web. '
            + 'For loopback-only debugging only, set allowUnauthenticatedLoopback: true.',
          )
        }
        sendRpcError(
          res,
          503,
          RpcErrorCode.SERVER_ERROR,
          'MCP endpoint is not configured with a Bearer token',
        )
        return
      }
      if (authorization === 'unauthorized') {
        sendRpcError(res, 401, RpcErrorCode.SERVER_ERROR, 'Unauthorized', {
          'www-authenticate': 'Bearer realm="antidsh-mcp"',
        })
        return
      }
      if (authorization === 'unauthenticated-loopback' && !warnedUnauthenticated) {
        warnedUnauthenticated = true
        logger.warn(
          '[antidsh-mcp] authenticated only by loopback peer: any local process can drive sessions. '
          + 'Configure a token before exposing this dsh web instance.',
        )
      }

      if (req.method === 'POST') {
        await handlePost(req, res, { protocolOptions, maxBodyBytes, bodyTimeoutMs })
        return
      }
      if (req.method === 'DELETE') {
        // The transport is stateless, so there is no server-side session to
        // terminate; answer 204 as the spec allows and drain any body.
        req.resume()
        res.writeHead(204, {
          'cache-control': 'no-store',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'content-length': '0',
        })
        res.end()
        return
      }

      req.resume()
      sendRpcError(
        res,
        405,
        RpcErrorCode.INVALID_REQUEST,
        `Method ${req.method ?? 'unknown'} is not allowed on the MCP endpoint`,
        { allow: 'POST, DELETE, OPTIONS' },
      )
    } catch (error) {
      logger.error('[antidsh-mcp] request handling failed', error)
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendRpcError(res, 500, RpcErrorCode.INTERNAL_ERROR, 'Internal error')
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ protocolOptions: import('./protocol.js').ProtocolOptions, maxBodyBytes: number, bodyTimeoutMs: number }} context
 * @returns {Promise<void>}
 */
async function handlePost(req, res, context) {
  const declaredVersion = headerValue(req.headers, 'mcp-protocol-version')
  if (
    declaredVersion !== undefined
    && declaredVersion.length > 0
    && !isCompatibleProtocolVersion(declaredVersion)
  ) {
    sendRpcError(
      res,
      400,
      RpcErrorCode.INVALID_REQUEST,
      `Unsupported MCP-Protocol-Version: ${declaredVersion}`,
    )
    return
  }

  let raw
  try {
    raw = await readBody(req, context.maxBodyBytes, context.bodyTimeoutMs)
  } catch (error) {
    if (error instanceof BodyReadError && error.code === 'too-large') {
      sendRpcError(
        res,
        413,
        RpcErrorCode.SERVER_ERROR,
        `Request body exceeds ${String(context.maxBodyBytes)} bytes`,
        { connection: 'close' },
      )
      return
    }
    if (error instanceof BodyReadError && error.code === 'timeout') {
      sendRpcError(
        res,
        408,
        RpcErrorCode.SERVER_ERROR,
        'Timed out while reading the request body',
        { connection: 'close' },
      )
      return
    }
    sendRpcError(res, 400, RpcErrorCode.PARSE_ERROR, 'Could not read the request body')
    return
  }

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    sendRpcError(res, 400, RpcErrorCode.PARSE_ERROR, 'Parse error')
    return
  }

  // A long `dsh_wait` legitimately holds the response open, so the body-read
  // timeout must not cover it. Instead, wire a client disconnect to an
  // AbortSignal and hand that signal to every controller call, so a cancelled
  // tool call stops the wait in dsh instead of leaking it.
  const abort = new AbortController()
  const onAborted = () => abort.abort()
  const onClose = () => {
    if (!res.writableEnded) abort.abort()
  }
  req.once('aborted', onAborted)
  res.once('close', onClose)

  try {
    const protocolOptions = {
      ...context.protocolOptions,
      context: { ...(context.protocolOptions.context ?? {}), signal: abort.signal },
    }
    const response = await handlePayload(payload, protocolOptions)
    if (abort.signal.aborted || res.destroyed || res.writableEnded) return
    if (response === null) {
      res.writeHead(202, {
        'cache-control': 'no-store',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'content-length': '0',
      })
      res.end()
      return
    }
    writeJson(res, 200, response)
  } finally {
    req.off('aborted', onAborted)
    res.off('close', onClose)
  }
}

/**
 * Read a request body with a hard byte cap and a wall-clock timeout.
 *
 * An oversized body is drained before rejecting so the client can read the
 * 413 response instead of seeing a reset connection. The timeout is cleared as
 * soon as the promise settles, so a long-lived keep-alive socket does not keep
 * a timer alive.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
export function readBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let received = 0
    let settled = false

    /** @type {NodeJS.Timeout} */
    let timer

    /**
     * @param {() => void} settle
     * @returns {void}
     */
    const finish = (settle) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onError)
      settle()
    }

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      received += chunk.length
      if (received > maxBytes) {
        req.resume()
        finish(() => reject(new BodyReadError('too-large', 'request body exceeds the configured limit')))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString('utf8')))
    const onAborted = () => finish(() => reject(new BodyReadError('aborted', 'request aborted')))
    const onError = (error) => finish(() => reject(error))

    const declaredLength = Number(headerValue(req.headers ?? {}, 'content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume()
      reject(new BodyReadError('too-large', 'declared content-length exceeds the configured limit'))
      return
    }

    timer = setTimeout(() => {
      req.resume()
      finish(() => reject(new BodyReadError('timeout', 'timed out reading the request body')))
    }, timeoutMs)

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('aborted', onAborted)
    req.on('error', onError)
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {McpHttpSecurity} security
 * @returns {'ok' | 'unauthenticated-loopback' | 'unauthorized' | 'unconfigured'}
 */
function authorize(req, security) {
  if (typeof security.token === 'string' && security.token.length > 0) {
    return secureEquals(bearerToken(req), security.token) ? 'ok' : 'unauthorized'
  }
  if (security.allowUnauthenticatedLoopback === true && isLoopbackPeer(req)) {
    return 'unauthenticated-loopback'
  }
  return 'unconfigured'
}

/**
 * @param {import('node:http').IncomingHttpHeaders | undefined} headers
 * @param {string} name lower-case header name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
  const value = headers?.[name]
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim()
  return undefined
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {number} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 */
function sendRpcError(res, status, code, message, extraHeaders = {}) {
  writeJson(
    res,
    status,
    { jsonrpc: '2.0', id: null, error: { code, message } },
    extraHeaders,
  )
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [extraHeaders]
 */
function writeJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
