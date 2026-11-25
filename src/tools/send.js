/**
 * `dsh_send` — dispatch work into an existing session.
 *
 * `cursor_before` is captured from `state()` before the prompt is accepted so
 * the optional short wait sees only output produced by this request. That is
 * what makes a queued send observable by an external orchestrator without
 * racing against old assistant history.
 */

import { randomUUID } from 'node:crypto'

import { isObject } from '../protocol.js'
import {
  assertAllowedKeys,
  argumentsOf,
  invalidArgument,
  readEnum,
  readInteger,
  readString,
  readText,
  signalOf,
} from './args.js'
import { compactWait } from '../format.js'

const MODES = ['queue', 'steer']
const ALLOWED_KEYS = ['session_id', 'prompt', 'mode', 'wait_ms']
const WEB_HINT = 'Open the dsh web UI to watch or intervene; approvals and questions are answered there.'

/**
 * @param {any} controller
 * @param {{ defaultWaitMs?: number }} config
 * @returns {import('../protocol.js').ToolDefinition}
 */
export function createSendTool(controller, config = {}) {
  const configuredDefault = normalizeDefaultWait(config.defaultWaitMs)
  const defaultWait = configuredDefault === 0 ? null : configuredDefault
  const waitHint = defaultWait === null
    ? 'Set wait_ms to 1000..25000 to return a short progress snapshot; omit it for an immediate accepted response.'
    : `Set wait_ms to 0 for an immediate accepted response, or 1000..25000 to override the default ${defaultWait}ms progress wait.`

  return {
    name: 'dsh_send',
    description: [
      'Send a prompt to an existing dsh session.',
      'mode="queue" adds it to the input queue; mode="steer" redirects the running turn.',
      waitHint,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id from dsh_session(list).' },
        prompt: { type: 'string', description: 'Prompt text; must not be blank.' },
        mode: {
          type: 'string',
          enum: MODES,
          description: 'queue (default) or steer (interrupt the current turn).',
        },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: 25000,
          description: defaultWait === null
            ? '0 returns immediately (default); 1000..25000 waits briefly for a snapshot.'
            : `0 returns immediately; when omitted, waits ${defaultWait}ms; 1000..25000 overrides.`,
        },
      },
      required: ['session_id', 'prompt'],
      additionalProperties: false,
    },

    async handler(input, context) {
      const args = argumentsOf(input)
      assertAllowedKeys(args, ALLOWED_KEYS)

      const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
      const prompt = readText(args, 'prompt', { required: true })
      const mode = readEnum(args, 'mode', MODES, { defaultValue: 'queue' })
      const waitMs = readInteger(args, 'wait_ms', {
        defaultValue: configuredDefault,
        min: 0,
        max: 25_000,
      })
      if (waitMs !== 0 && waitMs < 1000) {
        throw invalidArgument('"wait_ms" must be 0 or between 1000 and 25000')
      }

      const signal = signalOf(context)
      const state = await controller.state({ sessionId }, signal)
      const cursorBefore = isObject(state) && typeof state.cursor === 'number' ? state.cursor : null
      if (cursorBefore === null) throw new Error('session state did not report a cursor')

      const requestId = randomUUID()
      await controller.prompt({
        requestId,
        sessionId,
        mode,
        content: [{ type: 'text', text: prompt }],
      }, signal)

      /** @type {Record<string, unknown>} */
      const result = {
        accepted: true,
        session_id: sessionId,
        mode,
        cursor_before: cursorBefore,
        web_hint: WEB_HINT,
      }

      if (waitMs > 0) {
        const waited = await controller.wait({
          sessionId,
          timeoutMs: waitMs,
          afterSeq: cursorBefore,
          maxMessages: 10,
        }, signal)
        result.wait = compactWait(waited, { maxChars: 2000 })
      }

      return result
    },
  }
}

/**
 * The configured default is either "do not wait" or a legal short wait.
 * A value between 1 and 999 cannot satisfy the tool contract, so it is treated
 * as zero instead of making every send fail at runtime.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeDefaultWait(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 0
  if (value === 0) return 0
  if (value >= 1000 && value <= 25_000) return value
  return 0
}
