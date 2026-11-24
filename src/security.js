/**
 * Security guards for the antidsh MCP endpoint.
 *
 * The endpoint hands an external agent the live session control plane of the
 * `dsh web` process, so it is guarded as carefully as a shell on this
 * machine:
 *
 * - a bearer token is mandatory unless the operator explicitly opts into
 *   unauthenticated loopback debugging;
 * - a browser `Origin` must be loopback. Requests without an `Origin` are
 *   native MCP clients and rely on the token instead;
 * - the `Host` header must name a loopback authority or the address this
 *   dsh web instance is bound to, so a DNS name resolving to 127.0.0.1 is not
 *   enough to reach the endpoint;
 * - token comparison is constant-time over SHA-256 digests, which keeps the
 *   timing of a wrong guess independent of its length and matching prefix.
 *
 * Everything here is a plain function over request-like objects so it can be
 * unit-tested without a listening socket. Only `node:crypto` and `node:net`
 * are imported.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

const IPV4_LOOPBACK = /^127\./
const TOKEN_DIGEST = 'sha256'

/**
 * @typedef {object} RequestLike
 * @property {string} [method]
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {{ remoteAddress?: string }} [socket]
 */

/**
 * @typedef {object} ResolvedTokenOptions
 * @property {string | null} token resolved bearer token, or null when unconfigured
 * @property {boolean} allowUnauthenticatedLoopback
 * @property {string[]} allowedHostnames non-loopback Host values accepted for this listener
 */

/**
 * Strip the brackets IPv6 literals carry inside a URL or Host header.
 *
 * @param {string} hostname
 * @returns {string}
 */
function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Extract the hostname portion of an HTTP `Host` header.
 *
 * Handles `example.test`, `127.0.0.1:3080`, `localhost:3080` and bracketed
 * IPv6 literals such as `[::1]:3080`. An unbracketed IPv6 literal is not a
 * valid Host header and yields null.
 *
 * @param {unknown} hostHeader
 * @returns {string | null}
 */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return null
  const header = hostHeader.trim().toLowerCase()
  if (header.length === 0) return null
  if (header.startsWith('[')) {
    const end = header.indexOf(']')
    return end === -1 ? null : header.slice(0, end + 1)
  }
  const colon = header.indexOf(':')
  const hostname = colon === -1 ? header : header.slice(0, colon)
  return hostname.length === 0 ? null : hostname
}

/**
 * Whether a hostname names this machine's loopback interface.
 *
 * `localhost`, `127.0.0.0/8`, `::1` and IPv4-mapped loopback addresses are
 * accepted. Everything else, including DNS names that happen to resolve to
 * 127.0.0.1, is rejected.
 *
 * @param {unknown} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false
  const bare = unbracket(hostname.trim().toLowerCase())
  if (bare.length === 0) return false
  if (bare === 'localhost') return true

  const family = isIP(bare)
  if (family === 4) return IPV4_LOOPBACK.test(bare)
  if (family !== 6) return false
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  if (bare.startsWith('::ffff:')) {
    const mapped = bare.slice('::ffff:'.length)
    return isIP(mapped) === 4 && IPV4_LOOPBACK.test(mapped)
  }
  return false
}

/**
 * Whether the request carries a Host header this listener may answer.
 *
 * Loopback authorities always pass; the dsh web bind address passes when it
 * was collected at registration time. A missing or malformed Host header is
 * rejected so the endpoint cannot be reached through a rebound DNS name.
 *
 * @param {RequestLike} req
 * @param {readonly string[]} [allowedHostnames]
 * @returns {boolean}
 */
export function isTrustedHost(req, allowedHostnames = []) {
  const hostname = hostnameOf(req?.headers?.host)
  if (hostname === null) return false
  if (isLoopbackHostname(hostname)) return true
  const bare = unbracket(hostname)
  return allowedHostnames.some((allowed) => {
    if (typeof allowed !== 'string' || allowed.trim().length === 0) return false
    return unbracket(allowed.trim().toLowerCase()) === bare
  })
}

/**
 * Whether the TCP peer is a loopback address.
 *
 * This is used only to decide whether the explicit unauthenticated-loopback
 * development mode applies; it never widens the non-loopback path.
 *
 * @param {RequestLike} req
 * @returns {boolean}
 */
export function isLoopbackPeer(req) {
  const address = req?.socket?.remoteAddress
  if (typeof address !== 'string') return false
  const bare = address.trim()
  if (isLoopbackHostname(bare)) return true
  return isLoopbackHostname(bare.replace(/^::ffff:/i, ''))
}

/**
 * Whether a browser-style request comes from a loopback origin.
 *
 * A request without an `Origin` header is a native MCP client and is allowed
 * through this check (the bearer token still applies). A literal
 * `Origin: null` is rejected: sandboxed frames and file:// pages produce it,
 * and neither is a loopback origin. Cross-origin browser fetches to loopback
 * are additionally rejected by the `Sec-Fetch-Site: cross-site` guard.
 *
 * @param {RequestLike} req
 * @returns {boolean}
 */
export function isTrustedOrigin(req) {
  const origin = req?.headers?.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  const value = origin.trim()
  if (value.length === 0 || value === 'null') return false
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return isLoopbackHostname(parsed.hostname)
}

/**
 * Whether the request is a browser fetch explicitly marked cross-site.
 *
 * @param {RequestLike} req
 * @returns {boolean}
 */
export function isCrossSiteRequest(req) {
  const value = req?.headers?.['sec-fetch-site']
  return typeof value === 'string' && value.trim().toLowerCase() === 'cross-site'
}

/**
 * Resolve the bearer token, preferring the plugin config over the environment.
 *
 * Surrounding whitespace is ignored for both sources so a trailing newline in
 * an environment variable cannot produce an unusable token. An empty result
 * means "unconfigured", never "any token".
 *
 * @param {unknown} configToken
 * @param {unknown} envToken
 * @returns {string | null}
 */
export function resolveToken(configToken, envToken) {
  if (typeof configToken === 'string' && configToken.trim().length > 0) return configToken.trim()
  if (typeof envToken === 'string' && envToken.trim().length > 0) return envToken.trim()
  return null
}

/**
 * Extract the credentials of an `Authorization: Bearer <token>` header.
 *
 * @param {RequestLike} req
 * @returns {string} the token, or an empty string when the header is absent or malformed
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization
  if (typeof header !== 'string') return ''
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header)
  return match === null ? '' : match[1]
}

/**
 * Compare two strings without leaking their length or matching prefix.
 *
 * Both inputs are hashed first, so `timingSafeEqual` always receives equal
 * length buffers; an empty or missing credential is just another wrong guess.
 *
 * @param {unknown} candidate
 * @param {unknown} expected
 * @returns {boolean}
 */
export function secureEquals(candidate, expected) {
  const left = digest(typeof candidate === 'string' ? candidate : '')
  const right = digest(typeof expected === 'string' ? expected : '')
  return timingSafeEqual(left, right)
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function digest(value) {
  return createHash(TOKEN_DIGEST).update(value, 'utf8').digest()
}
