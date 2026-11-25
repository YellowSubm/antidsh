#!/usr/bin/env node
/**
 * Zero-config stdio-to-Streamable-HTTP MCP bridge for Antigravity -> dsh.
 *
 * Standalone (Node >= 20 built-ins only) so it can be copied directly inside
 * `~/.gemini/config/plugins/antidsh/bridge/antidsh-bridge.mjs`.
 *
 * On every request, the bridge reads `<DSH_HOME>/antidsh-runtime.json` written
 * by `dsh-antidsh-mcp` inside `dsh Desktop` / `dsh web`, validates that the
 * target is a loopback URL, and forwards the JSON-RPC 2.0 request over HTTP
 * with the persisted Bearer token.
 *
 * - Survives `dsh Desktop` restarts and OS-assigned random port changes with
 *   zero configuration edits or Antigravity restarts.
 * - Keeps Antigravity healthy even when `dsh Desktop` is closed at boot by
 *   serving fallback `initialize`, `ping`, and `tools/list` responses and
 *   reporting a clear actionable tool error on `tools/call`.
 * - Propagates MCP `notifications/cancelled` to abort in-flight HTTP calls
 *   (e.g. a long `dsh_wait`).
 */

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_VERSION = '2025-03-26'
export const BRIDGE_SERVER_INFO = Object.freeze({
  name: 'dsh-antidsh-mcp',
  version: '0.2.0',
})

export const FALLBACK_INSTRUCTIONS = [
  'Reuse a live session with dsh_session(list) before creating one.',
  'dsh_send queues or steers work, dsh_wait waits for the next assistant reply,',
  'dsh_inspect reads summaries, events, or git diffs progressively, and dsh_control cancels,',
  'continues, or edits the queue. If a wait reports input-required, ask the human to approve',
  'or answer in the dsh web UI.',
].join(' ')

/**
 * Fallback tool definitions used only when `dsh Desktop` / `dsh web` is not
 * yet running during Antigravity startup. Once `dsh` is running, live
 * `tools/list` responses from `dsh-antidsh-mcp` take precedence.
 */
export const FALLBACK_TOOLS = Object.freeze([
  {
    name: 'dsh_session',
    description: 'List, search, create, rename, or fork dsh sessions. Call action="list" first and reuse a running or recent session instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'create', 'rename', 'fork'], description: 'list (default) | search | create | rename | fork' },
        query: { type: 'string', description: 'Required for action="search"; matched against session content.' },
        cwd: { type: 'string', description: 'Absolute working directory for action="create". Mutually exclusive with workspace_id.' },
        workspace_id: { type: 'string', description: 'dsh workspace id for action="create". Mutually exclusive with cwd.' },
        title: { type: 'string', description: 'Optional title for create, or new title for rename.' },
        session_id: { type: 'string', description: 'Target session for rename or fork.' },
        at_seq: { type: 'integer', minimum: 0, description: 'Fork cut sequence.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum rows for list/search (default 20, max 50).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_send',
    description: 'Send a prompt to an existing dsh session. mode="queue" adds to queue; mode="steer" redirects the running turn.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id from dsh_session(list).' },
        prompt: { type: 'string', description: 'Prompt text; must not be blank.' },
        mode: { type: 'string', enum: ['queue', 'steer'], description: 'queue (default) or steer.' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 25000, description: '0 (default) returns immediately; otherwise 1000..25000 waits briefly.' },
      },
      required: ['session_id', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description: 'Wait for a dsh session to become idle, need human input (input-required), or reach a timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        after_seq: { type: 'integer', minimum: 0, description: 'Only consider output after this cursor.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Maximum wait in milliseconds (default 45000).' },
        max_chars: { type: 'integer', minimum: 100, maximum: 200000, description: 'Character budget for the latest assistant text (default 4000).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_inspect',
    description: 'Inspect a dsh session progressively: summary (state, steps, usage, cache hit rate), events (paged with next_before_seq), or diff (read-only git status/diff).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        view: { type: 'string', enum: ['summary', 'events', 'diff'], description: 'summary (default) | events | diff' },
        before_seq: { type: 'integer', minimum: 0, description: 'events: page strictly before this sequence.' },
        through_seq: { type: 'integer', minimum: 0, description: 'events: inclusive cut-off sequence.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'events: page size (default 12, max 50).' },
        path: { type: 'string', description: 'diff: repository-relative file path for a single-file diff.' },
        max_chars: { type: 'integer', minimum: 200, maximum: 50000, description: 'Character budget for text sections (default 6000).' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_control',
    description: 'Control a dsh session: cancel the running turn, continue a paused/failed turn, or edit/remove/steer a queued item.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        action: { type: 'string', enum: ['cancel', 'continue', 'queue_edit', 'queue_remove', 'queue_steer'] },
        item_id: { type: 'string', description: 'Queued input item id, required for queue_* actions.' },
        text: { type: 'string', description: 'Replacement prompt text, required for queue_edit.' },
      },
      required: ['session_id', 'action'],
      additionalProperties: false,
    },
  },
])

const DEFAULT_FETCH_TIMEOUT_MS = 170_000
const IPV4_LOOPBACK = /^127\./

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRuntimeFile(env = process.env) {
  const override = typeof env?.ANTIDSH_RUNTIME_FILE === 'string' ? env.ANTIDSH_RUNTIME_FILE.trim() : ''
  if (override.length > 0) return override
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(dshHome, 'antidsh-runtime.json')
}

/**
 * Verify that an endpoint URL uses HTTP(S) on a loopback address so the bridge
 * never sends local Bearer tokens to a remote host.
 *
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isLoopbackUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) return false
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const bare = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (bare === 'localhost') return true
  const family = isIP(bare)
  if (family === 4) return IPV4_LOOPBACK.test(bare)
  if (family === 6) {
    if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
    if (bare.startsWith('::ffff:')) {
      const mapped = bare.slice('::ffff:'.length)
      return isIP(mapped) === 4 && IPV4_LOOPBACK.test(mapped)
    }
  }
  return false
}

/**
 * Resolve the live dsh MCP endpoint from explicit env overrides or the
 * runtime discovery file written by `dsh-antidsh-mcp`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: true, url: string, token: string | null, source: 'env' | 'runtime-file', filePath?: string } | { ok: false, reason: string, filePath: string }}
 */
export function readRuntime(env = process.env) {
  const envUrl = typeof env?.ANTIDSH_MCP_URL === 'string' ? env.ANTIDSH_MCP_URL.trim() : ''
  const filePath = resolveRuntimeFile(env)
  if (envUrl.length > 0) {
    if (!isLoopbackUrl(envUrl)) {
      return { ok: false, reason: `ANTIDSH_MCP_URL must be a loopback http(s) URL (got "${envUrl}")`, filePath }
    }
    const envToken = typeof env?.ANTIDSH_MCP_TOKEN === 'string' && env.ANTIDSH_MCP_TOKEN.trim().length > 0
      ? env.ANTIDSH_MCP_TOKEN.trim()
      : null
    return { ok: true, url: envUrl, token: envToken, source: 'env' }
  }

  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        reason: `Runtime discovery file not found at ${filePath}. Open dsh Desktop (or dsh web) with dsh-antidsh-mcp v0.2+ enabled.`,
        filePath,
      }
    }
    return {
      ok: false,
      reason: `Could not read runtime discovery file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: `Runtime discovery file ${filePath} is not valid JSON.`, filePath }
  }

  if (!isLoopbackUrl(parsed?.url)) {
    return {
      ok: false,
      reason: `Runtime discovery file ${filePath} contains an invalid or non-loopback endpoint URL.`,
      filePath,
    }
  }

  const token = typeof parsed.token === 'string' && parsed.token.trim().length > 0
    ? parsed.token.trim()
    : null
  return { ok: true, url: parsed.url, token, source: 'runtime-file', filePath }
}

/**
 * Create a testable JSON-RPC message handler that bridges MCP messages to the
 * live dsh HTTP endpoint.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} [options]
 */
export function createBridgeHandler(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  /** @type {Map<string | number, AbortController>} */
  const inFlight = new Map()

  /**
   * @param {unknown} message
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function handleMessage(message) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Message must be a JSON-RPC 2.0 object' },
      }
    }

    const method = typeof message.method === 'string' ? message.method : ''
    const hasId = message.id !== undefined && message.id !== null

    if (method === 'notifications/cancelled') {
      const targetId = message.params?.requestId
      if (targetId !== undefined && inFlight.has(targetId)) {
        inFlight.get(targetId).abort()
        inFlight.delete(targetId)
      }
      return null
    }

    if (method.startsWith('notifications/') || !hasId) {
      // Forward notifications best-effort if dsh is up; never emit a response.
      const rt = readRuntime(env)
      if (rt.ok) {
        try {
          await postJsonRpc(rt, message, { fetchImpl, timeoutMs: 5_000 })
        } catch {
          // Ignore notification delivery errors when dsh is offline.
        }
      }
      return null
    }

    const id = message.id
    const rt = readRuntime(env)

    if (!rt.ok) {
      return offlineFallback(id, method, rt.reason)
    }

    const controller = new AbortController()
    inFlight.set(id, controller)
    try {
      const response = await postJsonRpc(rt, message, {
        fetchImpl,
        timeoutMs,
        signal: controller.signal,
      })
      if (response.status === 202) return null
      if (response.status === 401 || response.status === 503) {
        const detail = await safeReadText(response)
        return toolOrRpcError(id, method, `dsh-antidsh-mcp rejected authentication (HTTP ${response.status}). Restart dsh Desktop to refresh ${rt.filePath ?? 'runtime file'}. ${detail}`.trim())
      }
      const text = await response.text()
      if (text.trim().length === 0) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: `Empty HTTP ${response.status} response from dsh MCP endpoint` },
        }
      }
      return JSON.parse(text)
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32800, message: 'Request cancelled' },
        }
      }
      const reason = `Cannot reach dsh at ${rt.url} (${error instanceof Error ? error.message : String(error)}). Open or restart dsh Desktop (with dsh-antidsh-mcp v0.2+ enabled) and retry.`
      return offlineFallback(id, method, reason)
    } finally {
      inFlight.delete(id)
    }
  }

  function abortAll() {
    for (const controller of inFlight.values()) controller.abort()
    inFlight.clear()
  }

  return { handleMessage, abortAll }
}

/**
 * @param {{ url: string, token: string | null }} runtime
 * @param {unknown} payload
 * @param {{ fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal }} options
 * @returns {Promise<Response>}
 */
async function postJsonRpc(runtime, payload, options) {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal !== undefined
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal

  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
  }
  if (runtime.token !== null) {
    headers.authorization = `Bearer ${runtime.token}`
  }

  return options.fetchImpl(runtime.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })
}

/**
 * Keep Antigravity's MCP session alive even if dsh Desktop is not open yet.
 *
 * @param {string | number} id
 * @param {string} method
 * @param {string} reason
 * @returns {Record<string, unknown>}
 */
function offlineFallback(id, method, reason) {
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: BRIDGE_SERVER_INFO,
        instructions: FALLBACK_INSTRUCTIONS,
      },
    }
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: FALLBACK_TOOLS } }
  }
  return toolOrRpcError(id, method, reason)
}

/**
 * @param {string | number} id
 * @param {string} method
 * @param {string} message
 * @returns {Record<string, unknown>}
 */
function toolOrRpcError(id, method, message) {
  if (method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: message }],
      },
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message },
  }
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function safeReadText(response) {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return ''
  }
}

function startStdioBridge() {
  const bridge = createBridgeHandler()
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  const writeLine = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      writeLine({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })
      return
    }

    void bridge.handleMessage(message)
      .then((response) => {
        if (response !== null) writeLine(response)
      })
      .catch((error) => {
        process.stderr.write(`[antidsh-bridge] unexpected error: ${error instanceof Error ? error.message : String(error)}\n`)
        if (message?.id !== undefined && message?.id !== null) {
          writeLine({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'Bridge internal error' },
          })
        }
      })
  })

  const shutdown = () => {
    bridge.abortAll()
  }
  rl.once('close', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  startStdioBridge()
}
