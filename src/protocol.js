/**
 * Minimal MCP protocol layer for the Streamable HTTP transport.
 *
 * This implements exactly the revision documented in docs/DESIGN.md
 * (2025-03-26), in plain JSON-RPC 2.0: every response on this endpoint is a
 * single JSON body, with no server-sent events and no long-lived stream. The
 * transport-level HTTP concerns (security, sizing, status codes) live in
 * `http.js`; this module only validates messages and dispatches methods.
 *
 * Keeping the protocol implementation in-tree (instead of depending on an MCP
 * SDK) avoids adding a second MCP runtime to the profile's module graph and
 * keeps the byte-level behavior of the endpoint easy to test.
 */

export const PROTOCOL_VERSION = '2025-03-26'
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION])

/**
 * A client may know a newer MCP revision than this server implements. MCP
 * negotiation makes `initialize` answer with the server's own revision, so the
 * client can downgrade; transport headers for a later revision are accepted
 * for that downgrade path instead of failing the connection outright.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompatibleProtocolVersion(value) {
  if (typeof value !== 'string') return false
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(value)) return true
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && value > PROTOCOL_VERSION
}

export const SERVER_INFO = Object.freeze({
  name: 'dsh-antidsh-mcp',
  version: '0.2.0',
})

/**
 * Short guidance for the external agent. `initialize` is the only place MCP
 * lets a server explain how its tools fit together, so this concentrates on
 * the intended order of use rather than repeating tool descriptions.
 */
export const INSTRUCTIONS = [
  'Reuse a live session with dsh_session(list) before creating one.',
  'dsh_send queues or steers work, dsh_wait waits for the next assistant reply,',
  'dsh_inspect reads summaries, events, or git diffs progressively, and dsh_control cancels,',
  'continues, or edits the queue. If a wait reports input-required, ask the human to approve',
  'or answer in the dsh web UI.',
].join(' ')

/** JSON-RPC 2.0 error codes used by this server (plus the reserved server error range). */
export const RpcErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
})

/**
 * An error raised deliberately by this server. The code and data are forwarded
 * to the JSON-RPC error object; a stack is never sent to the client.
 */
export class McpError extends Error {
  /**
   * @param {number} code JSON-RPC error code
   * @param {string} message safe, client-facing message
   * @param {unknown} [data] optional structured detail
   */
  constructor(code, message, data) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.data = data
  }
}

/**
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema JSON Schema for the tool input
 * @property {(input: Record<string, unknown>, context: ToolContext) => unknown | Promise<unknown>} handler
 */

/**
 * @typedef {object} ToolContext
 * @property {AbortSignal} [signal] aborted when the HTTP client disconnects
 */

/**
 * @typedef {object} ProtocolOptions
 * @property {readonly ToolDefinition[]} tools
 * @property {string} [instructions]
 * @property {{ name: string, version: string }} [serverInfo]
 * @property {ToolContext} [context]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build a JSON-RPC error response. Transport-level failures use a null id
 * because there is no request id to echo.
 *
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {Record<string, unknown>}
 */
export function rpcError(id, code, message, data) {
  /** @type {Record<string, unknown>} */
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id: id ?? null, error }
}

/**
 * @param {string | number | null} id
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Dispatch one JSON-RPC message.
 *
 * Returns null for notifications (no response is allowed) and a response
 * object otherwise. Invalid messages are answered with the appropriate
 * JSON-RPC error even when they look like notifications, matching the intent
 * of JSON-RPC 2.0.
 *
 * @param {unknown} message
 * @param {ProtocolOptions} options
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function handleRequest(message, options) {
  if (!isObject(message)) {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'Each message must be a JSON-RPC 2.0 object')
  }

  if (message.jsonrpc !== '2.0') {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'jsonrpc must be the string "2.0"')
  }

  if (typeof message.method !== 'string' || message.method.length === 0) {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'method must be a non-empty string')
  }

  if (message.id !== undefined && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number') {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'id must be a string, a number, or null')
  }

  if (!hasValidParams(message.params)) {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'params must be an object, an array, or omitted')
  }

  const notification = message.id === undefined || message.id === null
  if (message.method.startsWith('notifications/')) return null

  try {
    switch (message.method) {
      case 'initialize':
        return notification ? null : rpcResult(message.id, initializeResult(message.params, options))
      case 'ping':
        return notification ? null : rpcResult(message.id, {})
      case 'tools/list':
        return notification ? null : rpcResult(message.id, { tools: publicTools(options.tools) })
      case 'tools/call':
        if (notification) return null
        return await callTool(message.id, message.params, options)
      default:
        return notification
          ? null
          : rpcError(message.id, RpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${message.method}`)
    }
  } catch (error) {
    if (error instanceof McpError) {
      return notification ? null : rpcError(message.id, error.code, error.message, error.data)
    }
    // A defect in this server must not leak its stack or message to a client.
    return notification ? null : rpcError(message.id, RpcErrorCode.INTERNAL_ERROR, 'Internal error')
  }
}

/**
 * Dispatch a parsed HTTP body, including JSON-RPC batches.
 *
 * @param {unknown} payload
 * @param {ProtocolOptions} options
 * @returns {Promise<Record<string, unknown> | Record<string, unknown>[] | null>}
 */
export async function handlePayload(payload, options) {
  if (!Array.isArray(payload)) return handleRequest(payload, options)
  if (payload.length === 0) {
    return rpcError(null, RpcErrorCode.INVALID_REQUEST, 'A JSON-RPC batch must contain at least one message')
  }

  /** @type {Record<string, unknown>[]} */
  const responses = []
  for (const message of payload) {
    const response = await handleRequest(message, options)
    if (response !== null) responses.push(response)
  }
  return responses.length === 0 ? null : responses
}

/**
 * @param {unknown} params
 * @returns {boolean}
 */
function hasValidParams(params) {
  return params === undefined || params === null || isObject(params) || Array.isArray(params)
}

/**
 * @param {unknown} params
 * @param {ProtocolOptions} options
 * @returns {Record<string, unknown>}
 */
function initializeResult(params, options) {
  const requested = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
  const protocolVersion = requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION
  const serverInfo = options.serverInfo ?? SERVER_INFO
  const instructions = options.instructions ?? INSTRUCTIONS
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: serverInfo.name, version: serverInfo.version },
    ...(instructions.length > 0 ? { instructions } : {}),
  }
}

/**
 * @param {readonly ToolDefinition[]} tools
 * @returns {Array<{ name: string, description: string, inputSchema: Record<string, unknown> }>}
 */
function publicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * @param {string | number} id
 * @param {unknown} params
 * @param {ProtocolOptions} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function callTool(id, params, options) {
  const tools = options.tools
  if (!isObject(params) || typeof params.name !== 'string' || params.name.length === 0) {
    return rpcError(id, RpcErrorCode.INVALID_PARAMS, 'tools/call requires a non-empty params.name')
  }
  const tool = tools.find((candidate) => candidate.name === params.name)
  if (tool === undefined) {
    return rpcError(id, RpcErrorCode.INVALID_PARAMS, `Unknown tool: ${params.name}`)
  }
  const args = params.arguments === undefined ? {} : params.arguments
  if (!isObject(args)) {
    return rpcError(id, RpcErrorCode.INVALID_PARAMS, 'tools/call params.arguments must be an object')
  }

  try {
    const value = await tool.handler(args, options.context ?? {})
    return rpcResult(id, {
      content: [{ type: 'text', text: stringifyJson(value) }],
    })
  } catch (error) {
    if (error instanceof McpError) return rpcError(id, error.code, error.message, error.data)
    // Tool failures are part of normal operation (unknown session, git absent,
    // ...), so report them as an MCP tool error instead of a protocol error.
    // Only the message crosses the boundary; stacks stay in the dsh log.
    return rpcResult(id, {
      isError: true,
      content: [{ type: 'text', text: errorMessage(error) }],
    })
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return String(value)
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.message.length > 0) return error.message
  return 'Tool execution failed'
}
