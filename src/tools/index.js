/**
 * The five tools exposed over MCP. Kept in one place so the protocol layer
 * never needs to know which controller-backed module owns a tool name.
 */

import { createControlTool } from './control.js'
import { createInspectTool } from './inspect.js'
import { createSendTool } from './send.js'
import { createSessionTool } from './session.js'
import { createWaitTool } from './wait.js'

/**
 * @param {any} controller
 * @param {{ defaultWaitMs?: number, workspaceController?: () => any, workspaceRegistry?: () => any }} [config]
 * @returns {import('../protocol.js').ToolDefinition[]}
 */
export function createTools(controller, config = {}) {
  return [
    createSessionTool(controller, {
      workspaceController: config.workspaceController,
      workspaceRegistry: config.workspaceRegistry,
    }),
    createSendTool(controller, { defaultWaitMs: config.defaultWaitMs }),
    createWaitTool(controller),
    createInspectTool(controller),
    createControlTool(controller),
  ]
}
