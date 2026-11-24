import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createMcpHandler, readBody } from '../src/http.js'
import { PROTOCOL_VERSION } from '../src/protocol.js'

const quietLogger = { info() {}, warn() {}, error() {} }

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
    throw new Error('tool exploded')
  },
}

function handlerFor(overrides = {}) {
  return createMcpHandler({
    tools: [echoTool, failingTool],
    security: { token: 'secret', allowedHostnames: [] },
    logger: quietLogger,
    ...overrides,
  })
}

/**
 * @param {import('node:http').RequestListener} handler
 * @param {(url: string, port: number) => Promise<void>} run
 */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${String(address.port)}/antidsh/mcp`
  try {
    await run(url, address.port)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [options]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(url, options = {}) {
  const { method = 'POST', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

function rpc(url, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return request(url, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      authorization: 'Bearer secret',
      ...headers,
    },
    body,
  })
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
}

test('fails closed with 503 when no token is configured', async () => {
  await withServer(handlerFor({ security: { token: null } }), async (url) => {
    const response = await request(url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize),
    })
    assert.equal(response.status, 503)
    const body = JSON.parse(response.body)
    assert.equal(body.jsonrpc, '2.0')
    assert.equal(body.id, null)
    assert.equal(body.error.code, -32000)
    assert.match(body.error.message, /not configured with a Bearer token/)
  })
})

test('allows unauthenticated loopback only when explicitly enabled', async () => {
  await withServer(
    handlerFor({ security: { token: null, allowUnauthenticatedLoopback: true } }),
    async (url) => {
      const response = await request(url, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(initialize),
      })
      assert.equal(response.status, 200)
      assert.equal(JSON.parse(response.body).result.protocolVersion, PROTOCOL_VERSION)
    },
  )
})

test('rejects a missing or wrong Bearer token and accepts the configured one', async () => {
  await withServer(handlerFor(), async (url) => {
    const missing = await request(url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize),
    })
    assert.equal(missing.status, 401)
    assert.match(String(missing.headers['www-authenticate']), /^Bearer /)
    assert.equal(JSON.parse(missing.body).error.code, -32000)

    const wrong = await rpc(url, initialize, { authorization: 'Bearer wrong' })
    assert.equal(wrong.status, 401)

    const accepted = await rpc(url, initialize)
    assert.equal(accepted.status, 200)
    assert.equal(JSON.parse(accepted.body).result.protocolVersion, PROTOCOL_VERSION)
  })
})

test('initialize advertises the protocol revision and instructions', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await rpc(url, initialize, { 'mcp-protocol-version': PROTOCOL_VERSION })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(response.headers['mcp-protocol-version'], PROTOCOL_VERSION)
    const result = JSON.parse(response.body).result
    assert.equal(result.protocolVersion, PROTOCOL_VERSION)
    assert.deepEqual(result.capabilities, { tools: {} })
    assert.match(result.instructions, /dsh_session/)
  })
})

test('supports ping, tools/list and tools/call', async () => {
  await withServer(handlerFor(), async (url) => {
    const ping = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'ping' })
    assert.deepEqual(JSON.parse(ping.body).result, {})

    const list = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const tools = JSON.parse(list.body).result.tools
    assert.deepEqual(tools.map((tool) => tool.name), ['echo', 'failing'])

    const call = await rpc(url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'hello' } },
    })
    assert.equal(call.status, 200)
    const content = JSON.parse(call.body).result.content
    assert.equal(content[0].type, 'text')
    assert.deepEqual(JSON.parse(content[0].text), { echoed: 'hello' })
  })
})

test('tool handler failures return an MCP tool error without a stack', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'failing' },
    })
    const result = JSON.parse(response.body).result
    assert.equal(result.isError, true)
    assert.equal(result.content[0].text, 'tool exploded')
    assert.equal(response.body.includes('at '), false)
  })
})

test('notifications are accepted with 202 and an empty body', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(response.status, 202)
    assert.equal(response.body, '')
  })
})

test('supports JSON-RPC batches', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await rpc(url, [
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'ping' },
    ])
    assert.equal(response.status, 200)
    const body = JSON.parse(response.body)
    assert.ok(Array.isArray(body))
    assert.deepEqual(body.map((item) => item.id), [10, 11])
  })
})

test('malformed JSON and invalid messages use JSON-RPC errors', async () => {
  await withServer(handlerFor(), async (url) => {
    const parse = await rpc(url, '{"jsonrpc":')
    assert.equal(parse.status, 400)
    assert.equal(JSON.parse(parse.body).error.code, -32700)

    const invalid = await rpc(url, { jsonrpc: '2.0', id: 1 })
    assert.equal(invalid.status, 200)
    assert.equal(JSON.parse(invalid.body).error.code, -32600)
  })
})

test('rejects an unsupported MCP-Protocol-Version header', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await rpc(url, initialize, { 'mcp-protocol-version': '1900-01-01' })
    assert.equal(response.status, 400)
    assert.match(JSON.parse(response.body).error.message, /Unsupported MCP-Protocol-Version/)
  })
})

test('GET is 405 with an Allow header, DELETE is 204, OPTIONS is 204', async () => {
  await withServer(handlerFor(), async (url) => {
    const get = await request(url, {
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
    })
    assert.equal(get.status, 405)
    assert.equal(get.headers.allow, 'POST, DELETE, OPTIONS')

    const del = await request(url, {
      method: 'DELETE',
      headers: { authorization: 'Bearer secret' },
    })
    assert.equal(del.status, 204)
    assert.equal(del.body, '')

    const options = await request(url, { method: 'OPTIONS' })
    assert.equal(options.status, 204)
    assert.equal(options.headers.allow, 'POST, DELETE, OPTIONS')
  })
})

test('rejects a DNS-rebinding Host header before authentication', async () => {
  await withServer(handlerFor(), async (url) => {
    const response = await request(url, {
      headers: {
        'content-type': 'application/json',
        host: 'rebind.example:3080',
      },
      body: JSON.stringify(initialize),
    })
    assert.equal(response.status, 403)
    assert.match(JSON.parse(response.body).error.message, /Host header/)
  })
})

test('enforces loopback origins for browser requests', async () => {
  await withServer(handlerFor(), async (url) => {
    const loopbackOrigin = await rpc(url, initialize, { origin: 'http://127.0.0.1:3080' })
    assert.equal(loopbackOrigin.status, 200)

    const foreign = await rpc(url, initialize, { origin: 'http://evil.example' })
    assert.equal(foreign.status, 403)

    const nullOrigin = await rpc(url, initialize, { origin: 'null' })
    assert.equal(nullOrigin.status, 403)

    const crossSite = await rpc(url, initialize, {
      origin: 'http://evil.example',
      'sec-fetch-site': 'cross-site',
    })
    assert.equal(crossSite.status, 403)
  })
})

test('enforces the request body size limit', async () => {
  await withServer(handlerFor({ maxBodyBytes: 128 }), async (url) => {
    const response = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(512) } })
    assert.equal(response.status, 413)
    assert.match(JSON.parse(response.body).error.message, /exceeds 128 bytes/)
  })
})

test('readBody enforces its byte cap and timeout directly', async () => {
  await assert.rejects(
    readBody(Readable.from([Buffer.alloc(64)]), 16, 1_000),
    /exceeds the configured limit/,
  )

  const stalled = new Readable({ read() {} })
  stalled.push('{"jsonrpc":')
  try {
    await assert.rejects(readBody(stalled, 1_024, 25), /timed out reading/)
  } finally {
    stalled.destroy()
  }
})

test('a newer MCP-Protocol-Version header is accepted and initialize downgrades', async () => {
  const handler = handlerFor()
  await withServer(handler, async (url) => {
    const response = await rpc(
      url,
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { 'mcp-protocol-version': '2025-06-18' },
    )
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).result.protocolVersion, PROTOCOL_VERSION)
  })
})

test('a client disconnect aborts the signal passed to a tool', async () => {
  let aborted = false
  const blockingTool = {
    name: 'blocking',
    description: 'Resolves only when its signal aborts.',
    inputSchema: { type: 'object' },
    handler: async (input, context) => new Promise((resolve) => {
      const finish = () => {
        aborted = true
        resolve({ aborted: true })
      }
      if (context.signal.aborted) {
        finish()
        return
      }
      context.signal.addEventListener('abort', finish, { once: true })
    }),
  }
  const handler = handlerFor({ tools: [blockingTool] })
  await withServer(handler, async (url) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'blocking', arguments: {} },
    })
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        authorization: 'Bearer secret',
      },
    })
    req.on('error', () => {})
    req.end(body)
    await new Promise((resolve) => setTimeout(resolve, 100))
    req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
  })
  assert.equal(aborted, true)
})

test('a long tool response is not killed by the request-body timeout', async () => {
  const slowTool = {
    name: 'slow',
    description: 'Responds after the body timeout would have fired.',
    inputSchema: { type: 'object' },
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { ok: true }
    },
  }
  const handler = handlerFor({ tools: [slowTool], bodyTimeoutMs: 50 })
  await withServer(handler, async (url) => {
    const response = await rpc(url, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    })
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.deepEqual(JSON.parse(payload.result.content[0].text), { ok: true })
  })
})
