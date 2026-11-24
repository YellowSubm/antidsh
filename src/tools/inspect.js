/**
 * `dsh_inspect` — read-only visibility into a live session.
 *
 * Three progressive views:
 *   summary  one screen: state, model, recent steps, usage, queue depth
 *   events   a compact cursor-paged event log
 *   diff     read-only git status / stat / single-file diff for the session cwd
 */

import { isObject, McpError } from '../protocol.js'
import {
  aggregateUsage,
  blocksText,
  clip,
  isAssistantRecord,
  summarizeEvent,
} from '../format.js'
import { inspectGit } from '../git.js'
import {
  assertAllowedKeys,
  argumentsOf,
  readEnum,
  readInteger,
  readRelativePath,
  readString,
  signalOf,
} from './args.js'

const VIEWS = ['summary', 'events', 'diff']
const ALLOWED_KEYS = ['session_id', 'view', 'before_seq', 'through_seq', 'limit', 'path', 'max_chars']
const DEFAULT_MAX_CHARS = 6000
const MAX_EVENTS = 50

/**
 * @param {any} controller
 * @param {{ inspectGit?: typeof inspectGit }} [options]
 * @returns {import('../protocol.js').ToolDefinition}
 */
export function createInspectTool(controller, options = {}) {
  const gitInspector = options.inspectGit ?? inspectGit
  return {
    name: 'dsh_inspect',
    description: [
      'Inspect a dsh session without changing it.',
      'view="summary" reports state, model, recent steps, token usage and cache hit rate;',
      '"events" pages compact events with next_before_seq;',
      '"diff" runs read-only git status/stat in the session working directory, plus a single-file diff when path is given.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        view: {
          type: 'string',
          enum: VIEWS,
          description: 'summary (default) | events | diff',
        },
        before_seq: {
          type: 'integer',
          minimum: 0,
          description: 'events: page strictly before this sequence. Use next_before_seq from a previous call.',
        },
        through_seq: {
          type: 'integer',
          minimum: 0,
          description: 'events: inclusive cut-off sequence. Omit for the current end.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'events: number of events per page (default 12, max 50).',
        },
        path: {
          type: 'string',
          description: 'diff: repository-relative file path for a single-file diff.',
        },
        max_chars: {
          type: 'integer',
          minimum: 200,
          maximum: 50000,
          description: 'Character budget for text sections (default 6000).',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },

    async handler(input, context) {
      const args = argumentsOf(input)
      assertAllowedKeys(args, ALLOWED_KEYS)

      const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
      const view = readEnum(args, 'view', VIEWS, { defaultValue: 'summary' })
      const maxChars = readInteger(args, 'max_chars', {
        defaultValue: DEFAULT_MAX_CHARS,
        min: 200,
        max: 50_000,
      })
      const signal = signalOf(context)

      if (view === 'events') {
        const beforeSeq = readInteger(args, 'before_seq', { min: 0 })
        const throughSeq = readInteger(args, 'through_seq', { min: 0 })
        const limit = readInteger(args, 'limit', { defaultValue: 12, min: 1, max: MAX_EVENTS })
        return inspectEvents(controller, signal, sessionId, { beforeSeq, throughSeq, limit, maxChars })
      }
      if (view === 'diff') {
        const path = readRelativePath(args, 'path')
        return inspectDiff(controller, signal, sessionId, { path, maxChars, inspectGit: gitInspector })
      }
      return inspectSummary(controller, signal, sessionId, { maxChars })
    },
  }
}

/**
 * @param {any} controller
 * @param {AbortSignal} signal
 * @param {string} sessionId
 * @param {{ maxChars: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function inspectSummary(controller, signal, sessionId, options) {
  const state = await controller.state({ sessionId }, signal)
  const page = await controller.events({
    address: { kind: 'session', sessionId },
    maxMessages: 20,
  }, signal)
  const records = isObject(page) && Array.isArray(page.records) ? page.records : []

  const projection = await safeProjections(controller, sessionId, signal)
  const values = projectionValues(projection)

  const usages = []
  const steps = []
  for (const record of records) {
    if (isAssistantRecord(record)) {
      const usage = record.event?.data?.usage
      if (isObject(usage)) usages.push(usage)
    }
    if (isObject(record) && isObject(record.event)) {
      steps.push(summarizeEvent(record, Math.min(400, options.maxChars)))
    }
  }

  const usage = aggregateUsage(usages)
  usage.scope = page?.hasMore === true ? 'recent' : 'all'

  const recentSteps = steps.slice(-8)
  const queued = isObject(state) && Array.isArray(state.queue) ? state.queue : []

  return {
    session_id: sessionId,
    view: 'summary',
    title: typeof values.title === 'string' ? values.title : null,
    model: modelOf(values),
    cursor: isObject(state) && typeof state.cursor === 'number' ? state.cursor : null,
    active: isObject(state) && state.active === true,
    running: isObject(state) && state.running === true,
    queue_length: queued.length,
    queue: queued.map((item) => ({
      item_id: isObject(item) && typeof item.id === 'string' ? item.id : null,
      placement: isObject(item) && typeof item.placement === 'string' ? item.placement : null,
      preview: isObject(item) ? clip(blocksText(item.content), 200) : '',
    })),
    pending_input: isObject(state) && Array.isArray(state.pendingInput) ? state.pendingInput : [],
    recent_steps: recentSteps,
    usage,
    events: {
      scanned: records.length,
      has_more: page?.hasMore === true,
      cursor: isObject(page) && typeof page.cursor === 'number' ? page.cursor : null,
    },
    next: 'Use dsh_wait(after_seq=cursor) to observe progress; dsh_inspect(view="events", before_seq=...) pages older events.',
  }
}

/**
 * @param {any} controller
 * @param {AbortSignal} signal
 * @param {string} sessionId
 * @param {{ beforeSeq?: number, throughSeq?: number, limit: number, maxChars: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function inspectEvents(controller, signal, sessionId, options) {
  /** @type {Record<string, unknown>} */
  const request = {
    address: { kind: 'session', sessionId },
    maxMessages: options.limit,
  }
  if (options.beforeSeq !== undefined) request.beforeSeq = options.beforeSeq
  if (options.throughSeq !== undefined) request.throughSeq = options.throughSeq

  const page = await controller.events(request, signal)
  const records = isObject(page) && Array.isArray(page.records) ? page.records : []
  const eventBudget = Math.max(200, Math.floor(options.maxChars / Math.max(1, records.length)))
  const events = records
    .filter((record) => isObject(record) && isObject(record.event))
    .map((record) => summarizeEvent(record, eventBudget))

  const cursor = isObject(page) && typeof page.cursor === 'number' ? page.cursor : null
  const hasMore = isObject(page) && page.hasMore === true
  // `page.cursor` is the inclusive upper cut-off of this read (the current log
  // end), not the oldest event in the page. Paging with it would return the
  // same page forever, so point the caller at the earliest event actually seen.
  const seqs = events
    .map((event) => (isObject(event) && typeof event.seq === 'number' ? event.seq : null))
    .filter((seq) => seq !== null)
  const nextBeforeSeq = seqs.length > 0 ? Math.min(...seqs) : null

  /** @type {Record<string, unknown>} */
  const result = {
    session_id: sessionId,
    view: 'events',
    events,
    count: events.length,
    cursor,
    has_more: hasMore,
    next: hasMore
      ? 'Call dsh_inspect(view="events", before_seq=<next_before_seq>) to read older events.'
      : 'No older events are available.',
  }
  if (hasMore && nextBeforeSeq !== null) result.next_before_seq = nextBeforeSeq
  return result
}

/**
 * @param {any} controller
 * @param {AbortSignal} signal
 * @param {string} sessionId
 * @param {{ path?: string, maxChars: number, inspectGit: typeof inspectGit }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function inspectDiff(controller, signal, sessionId, options) {
  const session = await sessionCwd(controller, signal, sessionId)
  if (!session.found) {
    throw new McpError(-32602, `Session not found: ${sessionId}`)
  }
  if (session.cwd === null) {
    return {
      session_id: sessionId,
      view: 'diff',
      cwd: null,
      is_repo: false,
      error: 'the session has no working directory',
      note: 'Read-only: git status --short, git diff --stat, and an optional single-file diff. Nothing is staged or written.',
    }
  }
  const git = await options.inspectGit({
    cwd: session.cwd,
    path: options.path,
    maxChars: options.maxChars,
    signal,
  })
  return {
    session_id: sessionId,
    view: 'diff',
    ...git,
    note: 'Read-only: git status --short, git diff --stat, and an optional single-file diff. Nothing is staged or written.',
  }
}

/**
 * @param {any} controller
 * @param {AbortSignal} signal
 * @param {string} sessionId
 * @returns {Promise<{ found: boolean, cwd: string | null }>}
 */
async function sessionCwd(controller, signal, sessionId) {
  const value = await controller.list({}, signal)
  const items = isObject(value) && Array.isArray(value.items) ? value.items : []
  const match = items.find((item) => isObject(item) && item.sessionId === sessionId)
  if (!isObject(match)) return { found: false, cwd: null }
  return {
    found: true,
    cwd: typeof match.cwd === 'string' && match.cwd.length > 0 ? match.cwd : null,
  }
}

/**
 * @param {any} controller
 * @param {string} sessionId
 * @param {AbortSignal} signal
 * @returns {Promise<unknown>}
 */
async function safeProjections(controller, sessionId, signal) {
  try {
    return await controller.projections({ sessionId }, signal)
  } catch {
    return null
  }
}

/**
 * @param {unknown} projection
 * @returns {Record<string, any>}
 */
function projectionValues(projection) {
  if (!isObject(projection)) return {}
  if (isObject(projection.values)) return projection.values
  return {}
}

/**
 * @param {Record<string, any>} values
 * @returns {{ provider: string, model: string } | null}
 */
function modelOf(values) {
  const selection = values.modelSelection
  if (!isObject(selection)) return null
  const candidate = isObject(selection.next) ? selection.next : selection.lastUsed
  if (!isObject(candidate)) return null
  const provider = typeof candidate.provider === 'string' ? candidate.provider : null
  const model = typeof candidate.model === 'string' ? candidate.model : null
  if (provider === null || model === null) return null
  return { provider, model }
}
