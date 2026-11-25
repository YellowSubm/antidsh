/**
 * Progressive-disclosure formatters for the MCP tools.
 *
 * The dsh session log is rich: assistant messages, tool calls and results,
 * token accounting, titles, and turn boundaries. Returning it raw would burn
 * the caller's context and hide the signal, so every tool response is reduced
 * to the facts an orchestrating agent needs next: what happened, how the turn
 * ended, where the cursor is, and how much budget was spent.
 *
 * The functions here are pure. Tests exercise them directly with synthetic
 * recorded events, which keeps the tool modules thin.
 */

import { isObject } from './protocol.js'

/**
 * @typedef {object} SessionRecord
 * @property {'event'} [type]
 * @property {{ type?: string, seq?: number, time?: number, data?: unknown }} [event]
 */

/**
 * @param {unknown} value
 * @returns {{ type?: string, seq?: number, time?: number, data?: unknown } | null}
 */
function eventOf(value) {
  if (!isObject(value)) return null
  if (isObject(value.event)) return value.event
  // Tolerate a bare wire event so tests and future callers do not need the
  // `{ type: 'event', event }` wrapper.
  if (typeof value.type === 'string' && typeof value.seq === 'number') {
    return { type: value.type, seq: value.seq, time: typeof value.time === 'number' ? value.time : undefined, data: value.data }
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function dataOf(value) {
  const event = eventOf(value)
  return event !== null && isObject(event.data) ? event.data : null
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAssistantRecord(value) {
  return eventOf(value)?.type === 'assistant/message'
}

/**
 * @param {unknown} value
 * @returns {{ type: string, seq: number | null, time: string | null, data: Record<string, unknown> } | null}
 */
function recordHeader(value) {
  const event = eventOf(value)
  if (event === null) return null
  return {
    type: event.type ?? 'unknown',
    seq: typeof event.seq === 'number' ? event.seq : null,
    time: toIso(event.time),
    data: isObject(event.data) ? event.data : {},
  }
}

/**
 * @param {unknown} timestamp
 * @returns {string | null}
 */
export function toIso(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * Truncate by Unicode code point so a cut never splits a surrogate pair.
 *
 * @param {string} value
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : ''
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 0
  if (limit === 0) return { text: '', truncated: text.length > 0 }
  const characters = Array.from(text)
  if (characters.length <= limit) return { text, truncated: false }
  return { text: `${characters.slice(0, Math.max(1, limit - 1)).join('')}…`, truncated: true }
}

/**
 * @param {string} value
 * @param {number} maxChars
 * @returns {string}
 */
export function clip(value, maxChars) {
  return truncateText(value, maxChars).text
}

/**
 * Join the human-readable text blocks of a message, ignoring reasoning and
 * structured blocks that the orchestrator does not need in a summary.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function blocksText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Extract tool calls the assistant issued in one message. The call arguments
 * are already available here, so `dsh_wait` does not need a second `events()`
 * read just to tell the caller which tools ran.
 *
 * @param {unknown} message
 * @returns {Array<{ name: string, arguments: string, call_id: string | null }>}
 */
export function toolCallsOf(message) {
  if (!isObject(message) || !Array.isArray(message.content)) return []
  const calls = []
  for (const block of message.content) {
    if (!isObject(block) || block.type !== 'tool-call') continue
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    const rawArguments = block.arguments
    let rendered
    if (typeof rawArguments === 'string') rendered = rawArguments
    else {
      try {
        rendered = JSON.stringify(rawArguments ?? {})
      } catch {
        rendered = String(rawArguments)
      }
    }
    calls.push({
      name,
      arguments: clip(rendered, 400),
      call_id: typeof block.id === 'string' ? block.id : null,
    })
  }
  return calls
}

/**
 * @param {unknown} usage
 * @returns {boolean}
 */
function hasUsage(usage) {
  return isObject(usage) && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']
    .some((key) => typeof usage[key] === 'number')
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Aggregate the mutually-exclusive token counters from one or more
 * `assistant/message` events.
 *
 * `inputTokens` counts only the uncached input, so the cache hit rate uses
 * `cacheReadTokens / (inputTokens + cacheReadTokens)`; write-only prompts have
 * no denominator and report null instead of NaN.
 *
 * @param {readonly unknown[]} usages
 * @returns {{
 *   input_tokens: number,
 *   output_tokens: number,
 *   total_tokens: number,
 *   cache_read_tokens: number,
 *   cache_write_tokens: number,
 *   reasoning_tokens: number,
 *   messages: number,
 *   cache_hit_rate: number | null,
 * }}
 */
export function aggregateUsage(usages) {
  let input = 0
  let output = 0
  let total = 0
  let cacheRead = 0
  let cacheWrite = 0
  let reasoning = 0
  let messages = 0

  for (const usage of usages) {
    if (!hasUsage(usage)) continue
    messages += 1
    input += count(usage.inputTokens)
    output += count(usage.outputTokens)
    cacheRead += count(usage.cacheReadTokens)
    cacheWrite += count(usage.cacheWriteTokens)
    reasoning += count(usage.reasoningTokens)
    total += count(usage.totalTokens)
      || count(usage.inputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens) + count(usage.outputTokens)
  }

  const denominator = input + cacheRead
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    messages,
    cache_hit_rate: denominator > 0 ? Math.round((cacheRead / denominator) * 10_000) / 10_000 : null,
  }
}

/**
 * @param {unknown} usage
 * @returns {ReturnType<typeof aggregateUsage> | null}
 */
export function usageSummary(usage) {
  if (!hasUsage(usage)) return null
  return aggregateUsage([usage])
}

/**
 * @param {unknown} record
 * @returns {unknown}
 */
function usageOf(record) {
  const data = dataOf(record)
  return data?.usage
}

/**
 * @param {unknown} record
 * @param {{ maxChars?: number, includeUsage?: boolean }} [options]
 * @returns {Record<string, unknown> | null}
 */
export function assistantRecordSummary(record, options = {}) {
  const header = recordHeader(record)
  if (header === null || header.type !== 'assistant/message') return null
  const message = isObject(header.data.message) ? header.data.message : {}
  const text = truncateText(blocksText(message.content), options.maxChars ?? 4000)
  const result = {
    type: 'assistant',
    seq: header.seq,
    time: header.time,
    turn: typeof header.data.turn === 'number' ? header.data.turn : null,
    step: typeof header.data.step === 'number' ? header.data.step : null,
    text: text.text,
    text_truncated: text.truncated,
    tool_calls: toolCallsOf(message),
  }
  if (options.includeUsage !== false) {
    const usage = usageOf(record)
    if (usage !== undefined) result.usage = usageSummary(usage)
  }
  if (header.data.interrupted === true) result.interrupted = true
  return result
}

/**
 * Reduce one durable event to a compact, JSON-safe record. The fallback keeps
 * unknown event types discoverable without dumping their entire payload.
 *
 * @param {unknown} record
 * @param {number} maxChars
 * @returns {Record<string, unknown> | null}
 */
export function summarizeEvent(record, maxChars = 800) {
  const header = recordHeader(record)
  if (header === null) return null
  const { type, seq, time, data } = header
  const base = { seq, time }

  switch (type) {
    case 'assistant/message': {
      const summary = assistantRecordSummary(record, { maxChars, includeUsage: true })
      return summary
    }
    case 'user/message': {
      const message = isObject(data.message) ? data.message : data
      const text = truncateText(blocksText(message.content), maxChars)
      return {
        ...base,
        type: 'user',
        text: text.text,
        text_truncated: text.truncated,
      }
    }
    case 'tool/call': {
      const raw = typeof data.arguments === 'string'
        ? data.arguments
        : safeJson(data.arguments)
      return {
        ...base,
        type: 'tool_call',
        turn: typeof data.turn === 'number' ? data.turn : null,
        step: typeof data.step === 'number' ? data.step : null,
        name: typeof data.name === 'string' ? data.name : 'unknown',
        call_id: typeof data.callId === 'string' ? data.callId : null,
        arguments: clip(raw, Math.min(maxChars, 600)),
      }
    }
    case 'tool/result': {
      const message = isObject(data.message) ? data.message : {}
      const text = truncateText(blocksText(message.content), maxChars)
      const error = isObject(data.error) ? data.error : null
      return {
        ...base,
        type: 'tool_result',
        turn: typeof data.turn === 'number' ? data.turn : null,
        step: typeof data.step === 'number' ? data.step : null,
        call_id: typeof message.toolCallId === 'string' ? message.toolCallId : null,
        is_error: message.isError === true || error !== null,
        text: text.text,
        text_truncated: text.truncated,
        ...(error !== null && typeof error.reason === 'string' ? { error_reason: clip(error.reason, 300) } : {}),
      }
    }
    case 'session/title': {
      return {
        ...base,
        type: 'title',
        title: typeof data.title === 'string' ? clip(data.title, 300) : null,
      }
    }
    case 'turn/start':
    case 'turn/end': {
      return {
        ...base,
        type: type === 'turn/start' ? 'turn_start' : 'turn_end',
        turn: typeof data.turn === 'number' ? data.turn : null,
        ...(typeof data.reason === 'string' ? { reason: clip(data.reason, 200) } : {}),
      }
    }
    default: {
      return {
        ...base,
        type,
        summary: clip(safeJson(data), 300),
      }
    }
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Pick the assistant reply an orchestrator should read first. A final answer
 * (text without tool calls) wins over newer progress text, which wins over
 * nothing. Records must be chronological.
 *
 * @param {readonly unknown[]} assistantRecords
 * @param {number} [maxChars]
 * @returns {{ seq: number | null, kind: 'final' | 'progress' | 'none', text: string, truncated: boolean }}
 */
export function selectAssistantReply(assistantRecords, maxChars = 4000) {
  const records = Array.isArray(assistantRecords) ? assistantRecords : []
  let final = null
  let progress = null
  for (const record of records) {
    const header = recordHeader(record)
    if (header === null || header.type !== 'assistant/message') continue
    const message = isObject(header.data.message) ? header.data.message : {}
    const raw = blocksText(message.content)
    if (raw.trim().length === 0) continue
    const text = truncateText(raw, maxChars)
    const candidate = { seq: header.seq, kind: 'progress', text: text.text, truncated: text.truncated }
    progress = candidate
    if (toolCallsOf(message).length === 0) final = { ...candidate, kind: 'final' }
  }
  return final ?? progress ?? { seq: null, kind: 'none', text: '', truncated: false }
}

const RETRYABLE_FAILURES = new Set(['service', 'rate_limit', 'transport', 'timeout'])

const FAILURE_LABELS = {
  service: 'Upstream service error',
  rate_limit: 'Rate limit',
  transport: 'Transport error',
  auth: 'Authentication error',
  timeout: 'Timeout',
  aborted: 'Turn aborted',
  tool_error: 'Tool error',
  unknown: 'Session failure',
}

/**
 * Reduce the latest failed turn or attempt to a coarse, safe diagnosis.
 * Returns null when the current turn completed or produced a later message.
 *
 * @param {readonly unknown[]} records
 * @returns {{ category: 'service'|'rate_limit'|'transport'|'auth'|'timeout'|'aborted'|'tool_error'|'unknown', status: number | null, code: string | null, retryable: boolean, summary: string, hint: string } | null}
 */
export function extractFailure(records) {
  const list = Array.isArray(records) ? records : []
  let start = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (recordHeader(list[index])?.type === 'turn/start') {
      start = index + 1
      break
    }
  }

  for (let index = list.length - 1; index >= start; index -= 1) {
    const header = recordHeader(list[index])
    if (header === null) continue
    const { type, data } = header
    if (type === 'turn/end') {
      const reason = isObject(data.reason) ? data.reason : {}
      if (reason.kind === 'interrupted') return diagnoseFailure({ code: 'INTERRUPTED', message: 'the turn was interrupted' })
      if (reason.kind === 'aborted') return diagnoseFailure({ code: 'ABORTED', message: 'the turn was aborted' })
      if (reason.kind === 'error') return diagnoseFailure(isObject(reason.error) ? reason.error : data.error)
      if (reason.kind === 'completed') return null
      continue
    }
    if (type === 'assistant/message') return null
    if (type === 'llm/retry-started') return null
    if (type === 'assistant/attempt') {
      const failure = attemptFailure(data)
      if (failure !== null) return diagnoseFailure(failure)
      continue
    }
    if (type === 'llm/retry') {
      const failure = isObject(data.failure) ? data.failure : null
      const retry = typeof data.retry === 'number' ? data.retry : null
      const maxRetries = typeof data.maxRetries === 'number' ? data.maxRetries : null
      if (failure !== null && retry !== null && maxRetries !== null && retry >= maxRetries) {
        return diagnoseFailure(failure)
      }
    }
  }
  return null
}

/**
 * @param {unknown} data
 * @returns {Record<string, unknown> | null}
 */
function attemptFailure(data) {
  if (isObject(data.failure)) return data.failure
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = isObject(stream[index]) && isObject(stream[index].chunk) ? stream[index].chunk : null
    if (chunk === null || chunk.type !== 'finish' || !isObject(chunk.reason)) continue
    if (chunk.reason.kind === 'error' && isObject(chunk.reason.failure)) return chunk.reason.failure
    if (chunk.reason.kind === 'aborted') return { code: 'ABORTED', message: 'the assistant attempt was aborted' }
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {ReturnType<typeof diagnoseFailure>}
 */
function diagnoseFailure(value) {
  const failure = isObject(value) ? value : {}
  const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : null
  const status = typeof failure.status === 'number' && Number.isFinite(failure.status) ? failure.status : null
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  const category = failureCategory(code, status, message)
  return {
    category,
    status,
    code,
    retryable: RETRYABLE_FAILURES.has(category),
    summary: failureSummary(category, code, status, message),
    hint: failureHint(category),
  }
}

/**
 * @param {string | null} code
 * @param {number | null} status
 * @param {string} message
 * @returns {'service'|'rate_limit'|'transport'|'auth'|'timeout'|'aborted'|'tool_error'|'unknown'}
 */
function failureCategory(code, status, message) {
  const label = `${code ?? ''} ${message}`.toUpperCase()
  if (status === 429 || /RATE.?LIMIT|TOO.?MANY/.test(label)) return 'rate_limit'
  if (status === 401 || status === 403 || /INVALID.?CREDENTIAL|MISSING.?CREDENTIAL|AUTH|API.?KEY|UNAUTHORIZED|FORBIDDEN/.test(label)) return 'auth'
  if (status === 408 || status === 504 || /TIMEOUT|TIMED.?OUT|DEADLINE/.test(label)) return 'timeout'
  if (/ABORT|CANCEL|INTERRUPT/.test(label)) return 'aborted'
  if (status === 500 || status === 502 || status === 503 || /SERVER|SERVICE|UPSTREAM|BAD.?GATEWAY|OVERLOAD/.test(label)) return 'service'
  if (/ECONN|ENOTFOUND|EAI_AGAIN|NETWORK|SOCKET|TLS|DNS|FETCH|TRANSPORT|EMPTY.?RESPONSE|STREAM.?CLOSED/.test(label)) return 'transport'
  if (/TOOL/.test(label)) return 'tool_error'
  return 'unknown'
}

/**
 * @param {string} category
 * @param {string | null} code
 * @param {number | null} status
 * @param {string} message
 * @returns {string}
 */
function failureSummary(category, code, status, message) {
  const details = []
  if (code !== null) details.push(code)
  if (status !== null) details.push(`HTTP ${status}`)
  const detail = details.length > 0 ? ` (${details.join(', ')})` : ''
  return `${FAILURE_LABELS[category]}${detail}${message.length > 0 ? `: ${clip(message, 300)}` : ''}`
}

/**
 * @param {string} category
 * @returns {string}
 */
function failureHint(category) {
  switch (category) {
    case 'auth':
      return 'Credentials are missing or invalid. Fix them in the dsh web UI, then call dsh_control(action="continue").'
    case 'aborted':
      return 'The turn was aborted. Send a new prompt or call dsh_control(action="continue") to resume.'
    case 'tool_error':
      return 'A tool call failed. Inspect view="events" for the result, fix the cause, then retry.'
    case 'unknown':
      return 'Inspect view="events" for the terminal turn/end reason before deciding whether to continue.'
    default:
      return 'This failure is retryable. Call dsh_control(action="continue") to resume the same session.'
  }
}

/**
 * @typedef {object} CompactWaitOptions
 * @property {number} [maxChars]
 */

/**
 * Format the value returned by `sessionController.wait`.
 *
 * The controller returns assistant records newest-first; the summary restores
 * chronological order for tool calls while still reporting the latest reply.
 * Only assistant messages are present, so tool calls are extracted from their
 * content blocks instead of issuing another `events()` request.
 *
 * @param {unknown} value
 * @param {CompactWaitOptions} [options]
 * @returns {Record<string, unknown>}
 */
export function compactWait(value, options = {}) {
  const maxChars = options.maxChars ?? 4000
  const wait = isObject(value) ? value : {}
  const state = isObject(wait.state) ? wait.state : {}
  const output = isObject(wait.output) ? wait.output : {}
  const records = Array.isArray(output.records) ? output.records : []
  const chronological = [...records].reverse()

  const assistantRecords = chronological
    .map((record) => assistantRecordSummary(record, { maxChars, includeUsage: false }))
    .filter((summary) => summary !== null)
  const reply = selectAssistantReply(chronological, maxChars)

  const toolCalls = []
  let omittedToolCalls = 0
  for (const record of assistantRecords) {
    for (const call of record.tool_calls) {
      if (toolCalls.length < 25) toolCalls.push(call)
      else omittedToolCalls += 1
    }
  }

  const reason = typeof wait.reason === 'string' ? wait.reason : 'timeout'
  const usage = aggregateUsage(records.map((record) => usageOf(record)))
  const queue = Array.isArray(state.queue) ? state.queue : []

  return {
    reason,
    cursor: typeof state.cursor === 'number' ? state.cursor : null,
    active: state.active === true,
    running: state.running === true,
    pending_input: Array.isArray(state.pendingInput) ? state.pendingInput : [],
    queue_length: queue.length,
    message_count: records.length,
    latest_seq: reply.seq,
    latest_text: reply.text,
    latest_reply_kind: reply.kind,
    text_truncated: reply.truncated || output.truncated === true,
    tool_calls: toolCalls,
    tool_calls_truncated: omittedToolCalls > 0 || assistantRecords.reduce((sum, record) => sum + record.tool_calls.length, 0) > toolCalls.length,
    usage_delta: usage,
    failure: extractFailure(chronological),
    web_hint: waitHint(reason),
  }
}

/**
 * @param {string} reason
 * @returns {string}
 */
function waitHint(reason) {
  switch (reason) {
    case 'idle':
      return 'The turn is idle. Use dsh_inspect(view="summary") or view="diff" to verify the result before reporting success.'
    case 'input-required':
      return 'The session needs a human in the dsh web UI (approval or question). Ask the user to respond there, then call dsh_wait again.'
    default:
      return 'No assistant message arrived before the timeout. The turn may still be running; call dsh_wait again with the returned cursor or check dsh_inspect(view="summary").'
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function recordCount(value) {
  return Array.isArray(value) ? value.length : 0
}
