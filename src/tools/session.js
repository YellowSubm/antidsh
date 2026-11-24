/**
 * `dsh_session` — discovery and lifecycle of live dsh sessions.
 *
 * Listing is deliberately the recommended first call: a warm session already
 * owns a browser tab, working directory, and conversation state, so reusing it
 * is cheaper and more observable than creating a fresh one.
 */

import { isAbsolute, win32 } from 'node:path'

import { isObject } from '../protocol.js'
import {
  assertAllowedKeys,
  argumentsOf,
  invalidArgument,
  readEnum,
  readInteger,
  readOptionalString,
  readString,
  readText,
  signalOf,
} from './args.js'
import { toIso } from '../format.js'

const ACTIONS = ['list', 'search', 'create', 'rename', 'fork']

const ALLOWED_KEYS = [
  'action',
  'query',
  'cwd',
  'workspace_id',
  'title',
  'session_id',
  'at_seq',
  'limit',
]

/**
 * @param {{ list: Function, search: Function, create: Function, rename: Function, fork: Function }} controller
 * @returns {import('../protocol.js').ToolDefinition}
 */
export function createSessionTool(controller) {
  return {
    name: 'dsh_session',
    description: [
      'List, search, create, rename, or fork dsh sessions.',
      'Call action="list" first and reuse a running or recent session instead of creating a duplicate.',
      'Every listed session_id can be used with dsh_send, dsh_wait, dsh_inspect, and dsh_control.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'list (default) | search | create | rename | fork',
        },
        query: {
          type: 'string',
          description: 'Required for action="search"; matched against session content.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for action="create". Mutually exclusive with workspace_id.',
        },
        workspace_id: {
          type: 'string',
          description: 'dsh workspace id for action="create". Mutually exclusive with cwd.',
        },
        title: {
          type: 'string',
          description: 'Optional title for action="create" (applied with a follow-up rename), or the new title for action="rename".',
        },
        session_id: {
          type: 'string',
          description: 'Target session for rename or fork.',
        },
        at_seq: {
          type: 'integer',
          minimum: 0,
          description: 'Fork cut: fork after this event sequence. Omit to fork at the current end.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum rows for list/search (default 20, max 50).',
        },
      },
      additionalProperties: false,
    },

    async handler(input, context) {
      const args = argumentsOf(input)
      assertAllowedKeys(args, ALLOWED_KEYS)
      const action = readEnum(args, 'action', ACTIONS, { defaultValue: 'list' })
      const signal = signalOf(context)
      const limit = readInteger(args, 'limit', { defaultValue: 20, min: 1, max: 50 })

      switch (action) {
        case 'list':
          return listSessions(controller, signal, limit)
        case 'search':
          return searchSessions(controller, args, signal, limit)
        case 'create':
          return createSession(controller, args)
        case 'rename':
          return renameSession(controller, args)
        case 'fork':
          return forkSession(controller, args)
        default:
          throw invalidArgument(`unsupported action "${String(action)}"`)
      }
    },
  }
}

/**
 * @param {any} controller
 * @param {AbortSignal} signal
 * @param {number} limit
 * @returns {Promise<Record<string, unknown>>}
 */
async function listSessions(controller, signal, limit) {
  const value = await controller.list({}, signal)
  const items = isObject(value) && Array.isArray(value.items) ? value.items : []
  const rows = items
    .map((item) => {
      const summary = isObject(item) ? item : {}
      return {
        session_id: typeof summary.sessionId === 'string' ? summary.sessionId : null,
        title: titleOf(summary) ?? null,
        cwd: typeof summary.cwd === 'string' ? summary.cwd : null,
        running: summary.running === true,
        agent_available: summary.agentAvailable === true,
        updated_at: toIso(summary.updatedAt),
        last_seq: lastSeqOf(summary),
        _updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
      }
    })
    .sort((left, right) => right._updatedAt - left._updatedAt)
    .slice(0, limit)
    .map(({ _updatedAt, ...row }) => row)

  return rows
}

/**
 * @param {any} controller
 * @param {Record<string, unknown>} args
 * @param {AbortSignal} signal
 * @param {number} limit
 * @returns {Promise<Record<string, unknown>>}
 */
async function searchSessions(controller, args, signal, limit) {
  const query = readString(args, 'query', { required: true, maxLength: 2000 })
  const value = await controller.search({ query }, signal)
  const items = isObject(value) && Array.isArray(value.items) ? value.items : []
  const results = items
    .map((item) => {
      const result = isObject(item) ? item : {}
      return {
        session_id: typeof result.sessionId === 'string' ? result.sessionId : null,
        snippet: typeof result.snippet === 'string' ? result.snippet : '',
      }
    })
    .slice(0, limit)

  return {
    query,
    results,
    count: results.length,
    has_more: isObject(value) && value.hasMore === true,
  }
}

/**
 * @param {any} controller
 * @param {Record<string, unknown>} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function createSession(controller, args) {
  const cwd = readOptionalString(args, 'cwd', { maxLength: 4096 })
  const workspaceId = readOptionalString(args, 'workspace_id', { maxLength: 512 })
  const title = readText(args, 'title', { maxLength: 500 })

  if (cwd !== undefined && workspaceId !== undefined) {
    throw invalidArgument('"cwd" and "workspace_id" are mutually exclusive')
  }
  if (cwd !== undefined && !isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw invalidArgument('"cwd" must be an absolute path')
  }

  /** @type {{ cwd?: string, workspaceId?: string }} */
  const request = {}
  if (cwd !== undefined) request.cwd = cwd
  if (workspaceId !== undefined) request.workspaceId = workspaceId

  const created = await controller.create(request)
  const createdId = isObject(created) && typeof created.sessionId === 'string' ? created.sessionId : null
  if (createdId === null) throw new Error('session creation did not return a session id')

  let renamed = null
  if (title !== undefined) {
    const value = await controller.rename({ sessionId: createdId, title })
    renamed = isObject(value) && typeof value.title === 'string' ? value.title : title
  }

  return {
    session_id: createdId,
    title: renamed,
    cwd: cwd ?? null,
    workspace_id: workspaceId ?? null,
    next: 'Send the first prompt with dsh_send(mode="queue"), then wait with dsh_wait.',
  }
}

/**
 * @param {any} controller
 * @param {Record<string, unknown>} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function renameSession(controller, args) {
  const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
  const title = readText(args, 'title', { required: true, maxLength: 500 })
  const value = await controller.rename({ sessionId, title })
  return {
    session_id: sessionId,
    title: isObject(value) && typeof value.title === 'string' ? value.title : title,
    seq: isObject(value) && typeof value.seq === 'number' ? value.seq : null,
  }
}

/**
 * @param {any} controller
 * @param {Record<string, unknown>} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function forkSession(controller, args) {
  const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
  const atSeq = readInteger(args, 'at_seq', { min: 0 })
  /** @type {{ sessionId: string, atSeq?: number }} */
  const request = { sessionId }
  if (atSeq !== undefined) request.atSeq = atSeq
  const value = await controller.fork(request)
  const forkedId = isObject(value) && typeof value.sessionId === 'string' ? value.sessionId : null
  return {
    session_id: forkedId,
    parent_session_id: sessionId,
    at_seq: atSeq ?? null,
  }
}

/**
 * @param {Record<string, unknown>} summary
 * @returns {string | undefined}
 */
function titleOf(summary) {
  const projections = summary.projections
  if (isObject(projections) && isObject(projections.values)) {
    const title = projections.values.title
    if (typeof title === 'string' && title.length > 0) return title
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} summary
 * @returns {number | null}
 */
function lastSeqOf(summary) {
  if (isObject(summary.projections) && typeof summary.projections.asOfSeq === 'number') {
    return summary.projections.asOfSeq
  }
  return null
}
