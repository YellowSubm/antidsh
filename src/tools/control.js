/**
 * `dsh_control` — the small write surface for an already-running session.
 *
 * Cancel and continue affect the turn; queue_* edits one queued input item.
 * Everything else (approvals, questions, model choice) stays a human action in
 * the dsh web UI.
 */

import { randomUUID } from 'node:crypto'

import { isObject } from '../protocol.js'
import {
  assertAllowedKeys,
  argumentsOf,
  invalidArgument,
  readEnum,
  readString,
  readText,
  signalOf,
} from './args.js'

const ACTIONS = ['cancel', 'continue', 'queue_edit', 'queue_remove', 'queue_steer']
const ALLOWED_KEYS = ['session_id', 'action', 'item_id', 'text']
const WEB_HINT = 'Approvals, questions, and model changes are human actions in the dsh web UI.'

/**
 * @param {any} controller
 * @returns {import('../protocol.js').ToolDefinition}
 */
export function createControlTool(controller) {
  return {
    name: 'dsh_control',
    description: [
      'Control a dsh session: cancel the running turn, continue after a pause, or edit/remove/steer a queued item.',
      'queue_* actions require item_id from dsh_inspect(summary).queue; queue_edit also requires text.',
      'Approvals and questions cannot be answered here: ask the human to use the dsh web UI.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id.' },
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'cancel | continue | queue_edit | queue_remove | queue_steer',
        },
        item_id: {
          type: 'string',
          description: 'Queued input item id, required for queue_edit, queue_remove, and queue_steer.',
        },
        text: {
          type: 'string',
          description: 'Replacement prompt text, required for queue_edit.',
        },
      },
      required: ['session_id', 'action'],
      additionalProperties: false,
    },

    async handler(input, context) {
      const args = argumentsOf(input)
      assertAllowedKeys(args, ALLOWED_KEYS)

      const sessionId = readString(args, 'session_id', { required: true, maxLength: 512 })
      const action = readEnum(args, 'action', ACTIONS, { required: true })
      const signal = signalOf(context)

      if (action === 'cancel') {
        const value = await controller.cancel({ sessionId })
        return {
          accepted: isObject(value) && value.accepted === true,
          session_id: sessionId,
          action,
          web_hint: WEB_HINT,
        }
      }

      if (action === 'continue') {
        const requestId = randomUUID()
        await controller.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [],
        }, signal)
        return {
          accepted: true,
          session_id: sessionId,
          action,
          request_id: requestId,
          web_hint: WEB_HINT,
          next: 'Call dsh_wait(after_seq=<cursor>) to observe the continued turn.',
        }
      }

      const itemId = readString(args, 'item_id', { required: true, maxLength: 512 })
      if (action === 'queue_edit') {
        const text = readText(args, 'text', { required: true })
        const value = await controller.updateQueue({
          sessionId,
          itemId,
          action: { kind: 'edit', content: [{ type: 'text', text }] },
        })
        return {
          accepted: isObject(value) && value.accepted === true,
          session_id: sessionId,
          action,
          item_id: itemId,
          web_hint: WEB_HINT,
        }
      }

      if (action === 'queue_remove' || action === 'queue_steer') {
        const kind = action === 'queue_remove' ? 'remove' : 'steer'
        const value = await controller.updateQueue({
          sessionId,
          itemId,
          action: { kind },
        })
        return {
          accepted: isObject(value) && value.accepted === true,
          session_id: sessionId,
          action,
          item_id: itemId,
          web_hint: WEB_HINT,
        }
      }

      throw invalidArgument(`unsupported action "${String(action)}"`)
    },
  }
}
