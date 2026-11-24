import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  INSTRUCTIONS,
  PROTOCOL_VERSION,
  RpcErrorCode,
  handlePayload,
  handleRequest,
} from '../src/protocol.js'

const echoTool = {
  name: 'echo',
  description: 'Echo the input.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  handler: async (input) => ({ echoed: input.value ?? null }),
}

const failingTool = {
  name: 'failing',
  description: 'Always fails.',
  inputSchema: { type: 'object' },
  handler: async () => {
    throw new Error('boom')
  },
}

const options = { tools: [echoTool, failingTool], instructions: INSTRUCTIONS }

test('initialize returns the supported revision and instructions', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } },
    options,
  )
  assert.equal(response?.jsonrpc, '2.0')
  assert.equal(response?.id, 1)
  const result = response?.result
  assert.equal(result.protocolVersion, PROTOCOL_VERSION)
  assert.deepEqual(result.capabilities, { tools: {} })
  assert.equal(result.serverInfo.name, 'dsh-antidsh-mcp')
  assert.equal(typeof result.instructions, 'string')
  assert.match(result.instructions, /dsh_session/)
})

test('initialize falls back to the supported revision when the client asks for another', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    options,
  )
  assert.equal(response?.result.protocolVersion, PROTOCOL_VERSION)
})

test('ping succeeds with an empty result', async () => {
  assert.deepEqual(await handleRequest({ jsonrpc: '2.0', id: 2, method: 'ping' }, options), {
    jsonrpc: '2.0',
    id: 2,
    result: {},
  })
})

test('notifications/initialized produces no response', async () => {
  assert.equal(
    await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, options),
    null,
  )
})

test('tools/list exposes name, description and inputSchema only', async () => {
  const response = await handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, options)
  assert.deepEqual(response?.result, {
    tools: [
      {
        name: 'echo',
        description: 'Echo the input.',
        inputSchema: echoTool.inputSchema,
      },
      {
        name: 'failing',
        description: 'Always fails.',
        inputSchema: failingTool.inputSchema,
      },
    ],
  })
})

test('tools/call returns JSON text content', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { value: 'hi' } } },
    options,
  )
  const content = response?.result.content
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.deepEqual(JSON.parse(content[0].text), { echoed: 'hi' })
})

test('tools/call defaults arguments to an empty object', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo' } },
    options,
  )
  assert.deepEqual(JSON.parse(response?.result.content[0].text), { echoed: null })
})

test('tools/call reports handler failures as tool errors, without stacks', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'failing' } },
    options,
  )
  assert.equal(response?.result.isError, true)
  assert.equal(response?.result.content[0].text, 'boom')
  assert.equal(JSON.stringify(response).includes('at '), false)
})

test('tools/call rejects unknown tools and malformed arguments', async () => {
  const unknown = await handleRequest(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'missing' } },
    options,
  )
  assert.equal(unknown?.error.code, RpcErrorCode.INVALID_PARAMS)
  assert.match(unknown?.error.message, /Unknown tool/)

  const badArgs = await handleRequest(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: 'nope' } },
    options,
  )
  assert.equal(badArgs?.error.code, RpcErrorCode.INVALID_PARAMS)

  const noName = await handleRequest(
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} },
    options,
  )
  assert.equal(noName?.error.code, RpcErrorCode.INVALID_PARAMS)
})

test('unknown methods and malformed messages use protocol errors', async () => {
  const unknownMethod = await handleRequest({ jsonrpc: '2.0', id: 10, method: 'resources/list' }, options)
  assert.equal(unknownMethod?.error.code, RpcErrorCode.METHOD_NOT_FOUND)

  for (const message of [null, 'x', [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }]) {
    const response = await handleRequest(message, options)
    assert.equal(response?.error.code, RpcErrorCode.INVALID_REQUEST)
  }

  const badParams = await handleRequest(
    { jsonrpc: '2.0', id: 11, method: 'ping', params: 'string' },
    options,
  )
  assert.equal(badParams?.error.code, RpcErrorCode.INVALID_REQUEST)

  const badId = await handleRequest(
    { jsonrpc: '2.0', id: {}, method: 'ping' },
    options,
  )
  assert.equal(badId?.error.code, RpcErrorCode.INVALID_REQUEST)
})

test('batch requests answer each call and omit notifications', async () => {
  const response = await handlePayload(
    [
      { jsonrpc: '2.0', id: 20, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 21, method: 'ping' },
    ],
    options,
  )
  assert.ok(Array.isArray(response))
  assert.deepEqual(response.map((item) => item.id), [20, 21])
})

test('an empty batch and a notification-only batch are handled', async () => {
  const empty = await handlePayload([], options)
  assert.equal(empty?.error.code, RpcErrorCode.INVALID_REQUEST)

  const notifications = await handlePayload(
    [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
    options,
  )
  assert.equal(notifications, null)
})

test('initialize negotiates down from a newer client revision instead of rejecting it', async () => {
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    options,
  )
  assert.equal(response?.result.protocolVersion, PROTOCOL_VERSION)
})

test('tools/call forwards the request context signal to the tool handler', async () => {
  const signal = new AbortController().signal
  let received = null
  const tool = {
    name: 'contextual',
    description: 'Reports its context.',
    inputSchema: { type: 'object' },
    handler: async (input, context) => {
      received = context?.signal
      return { ok: true }
    },
  }
  const response = await handleRequest(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'contextual', arguments: {} } },
    { tools: [tool], context: { signal } },
  )
  assert.equal(received, signal)
  assert.equal(response?.result?.isError, undefined)
})
