/**
 * `dsh_wait` — block until a session reaches a decision point.
 *
 * This is the only tool that intentionally holds an HTTP request open for a
 * long time. The request-body timeout does not cover the response, and the
 * client's abort signal is propagated into the controller call so an
 * Antigravity-side cancellation stops the wait instead of leaking it.
 */

import {
  assertAllowedKeys,
  argumentsOf,
  readInteger,
  readString,
  signalOf,
} from './args.js'
import { compactWait } from '../format.js'

const ALLOWED_KEYS = ['session_id', 'after_seq', 'timeout_ms', 'max_chars']
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_TIMEOUT_MS = 120_000

/**
 * @param {any} controller
 * @returns {import('../protocol.js').ToolDefinition}
 */
export function createWaitTool(controller) {
  return {
    name: 'dsh_wait',
    description: [
      'Wait for a dsh session to become idle, need human input, or reach a timeout.',
      'Returns the newest assistant text (truncated), tool calls, token usage delta, and the cursor to pass to the next wait.',
      'reason="idle" means the turn finished; "input-required" means a human must answer in the dsh web UI; "timeout" means work is still in progress.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        after_seq: {
          type: 'integer',
          minimum: 0,
          description: 'Only consider output after this cursor. Omit to use the current end.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: 'Maximum wait in milliseconds (default 45000).',
        },
        max_chars: {
          type: 'integer',
          minimum: 100,
          maximum: 200000,
          description: 'Character budget for the latest assistant text (default 4000).',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },

    async handler(input, context) {
      const args = argumentsOf(input)
      assertAllowedKeys(args, ALLOWED_KEYS)

      const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
      const afterSeq = readInteger(args, 'after_seq', { min: 0 })
      const timeoutMs = readInteger(args, 'timeout_ms', {
        defaultValue: DEFAULT_TIMEOUT_MS,
        min: 1000,
        max: MAX_TIMEOUT_MS,
      })
      const maxChars = readInteger(args, 'max_chars', {
        defaultValue: 4000,
        min: 100,
        max: 200_000,
      })

      /** @type {Record<string, unknown>} */
      const request = { sessionId, timeoutMs, maxMessages: 10 }
      if (afterSeq !== undefined) request.afterSeq = afterSeq

      const waited = await controller.wait(request, signalOf(context))
      const compact = compactWait(waited, { maxChars })

      return {
        session_id: sessionId,
        timeout_ms: timeoutMs,
        ...compact,
      }
    },
  }
}
