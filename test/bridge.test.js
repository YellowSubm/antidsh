import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  FALLBACK_TOOLS,
  PROTOCOL_VERSION,
  createBridgeHandler,
  isLoopbackUrl,
  readRuntime,
} from '../antigravity-plugin/bridge/antidsh-bridge.mjs'

test('isLoopbackUrl accepts only loopback http(s) URLs', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:3081/antidsh/mcp'), true)
  assert.equal(isLoopbackUrl('http://localhost:3080/antidsh/mcp'), true)
  assert.equal(isLoopbackUrl('http://[::1]:3080/antidsh/mcp'), true)
  assert.equal(isLoopbackUrl('https://127.0.0.1:8443/mcp'), true)
  assert.equal(isLoopbackUrl('http://example.com/antidsh/mcp'), false)
  assert.equal(isLoopbackUrl('http://192.168.1.10:3080/antidsh/mcp'), false)
  assert.equal(isLoopbackUrl('file:///etc/passwd'), false)
  assert.equal(isLoopbackUrl('not-a-url'), false)
})

test('readRuntime discovers endpoint and token from DSH_HOME/antidsh-runtime.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-bridge-'))
  try {
    const missing = readRuntime({ DSH_HOME: dir })
    assert.equal(missing.ok, false)

    writeFileSync(
      join(dir, 'antidsh-runtime.json'),
      JSON.stringify({ url: 'http://127.0.0.1:51234/antidsh/mcp', token: 'tok-123' }),
      'utf8',
    )
    const found = readRuntime({ DSH_HOME: dir })
    assert.equal(found.ok, true)
    assert.equal(found.url, 'http://127.0.0.1:51234/antidsh/mcp')
    assert.equal(found.token, 'tok-123')
    assert.equal(found.source, 'runtime-file')

    // Rejects non-loopback runtime file URLs.
    writeFileSync(
      join(dir, 'antidsh-runtime.json'),
      JSON.stringify({ url: 'https://evil.example/mcp', token: 'tok-123' }),
      'utf8',
    )
    const rejected = readRuntime({ DSH_HOME: dir })
    assert.equal(rejected.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge keeps initialize/ping/tools-list healthy when dsh is offline and errors cleanly on tools/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-bridge-'))
  try {
    const bridge = createBridgeHandler({ env: { DSH_HOME: dir } })

    const init = await bridge.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    assert.equal(init.result.protocolVersion, PROTOCOL_VERSION)
    assert.ok(init.result.instructions.includes('dsh_session'))

    const ping = await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' })
    assert.deepEqual(ping.result, {})

    const list = await bridge.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    assert.equal(list.result.tools.length, FALLBACK_TOOLS.length)

    const call = await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'dsh_session', arguments: { action: 'list' } },
    })
    assert.equal(call.result.isError, true)
    assert.ok(call.result.content[0].text.includes('dsh Desktop'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bridge forwards requests with Bearer auth and seamlessly picks up port changes after dsh restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-bridge-'))
  try {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) })
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { content: [{ type: 'text', text: '[]' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const runtimePath = join(dir, 'antidsh-runtime.json')
    writeFileSync(runtimePath, JSON.stringify({ url: 'http://127.0.0.1:41001/antidsh/mcp', token: 'tok-a' }), 'utf8')

    const bridge = createBridgeHandler({ env: { DSH_HOME: dir }, fetchImpl })
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'dsh_session', arguments: { action: 'list' } },
    })

    // Simulate dsh Desktop restarting on a brand-new random port.
    writeFileSync(runtimePath, JSON.stringify({ url: 'http://127.0.0.1:52999/antidsh/mcp', token: 'tok-b' }), 'utf8')
    await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'dsh_session', arguments: { action: 'list' } },
    })

    assert.equal(seen.length, 2)
    assert.equal(seen[0].url, 'http://127.0.0.1:41001/antidsh/mcp')
    assert.equal(seen[0].auth, 'Bearer tok-a')
    assert.equal(seen[1].url, 'http://127.0.0.1:52999/antidsh/mcp')
    assert.equal(seen[1].auth, 'Bearer tok-b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('notifications/cancelled aborts the matching in-flight request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'antidsh-bridge-'))
  try {
    writeFileSync(
      join(dir, 'antidsh-runtime.json'),
      JSON.stringify({ url: 'http://127.0.0.1:41001/antidsh/mcp', token: 'tok-a' }),
      'utf8',
    )

    let aborted = false
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })

    const bridge = createBridgeHandler({ env: { DSH_HOME: dir }, fetchImpl })
    const pending = bridge.handleMessage({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'dsh_wait', arguments: { session_id: 's1' } },
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    const cancelReply = await bridge.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 99 },
    })
    assert.equal(cancelReply, null)

    const response = await pending
    assert.equal(aborted, true)
    assert.equal(response.error.code, -32800)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
