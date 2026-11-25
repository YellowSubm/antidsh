import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSendTool } from '../src/tools/send.js'
import { createWaitTool } from '../src/tools/wait.js'

function makeSendController(overrides = {}) {
  const calls = []
  const controller = {
    async state(request, signal) {
      calls.push(['state', request, signal])
      return overrides.state ?? { cursor: 7, active: true, running: true, queue: [], pendingInput: [] }
    },
    async prompt(request, signal) {
      calls.push(['prompt', request, signal])
      return { accepted: true }
    },
    async wait(request, signal) {
      calls.push(['wait', request, signal])
      return overrides.wait ?? {
        reason: 'idle',
        state: { cursor: 8, active: true, running: false, queue: [], pendingInput: [] },
        output: {
          truncated: false,
          records: [{
            type: 'event',
            event: {
              type: 'assistant/message',
              seq: 8,
              time: 1,
              data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'finished' }] } },
            },
          }],
        },
      }
    },
  }
  return { controller, calls }
}

test('dsh_send captures cursor_before, queues the prompt, and does not wait by default', async () => {
  const { controller, calls } = makeSendController()
  const tool = createSendTool(controller, {})
  const result = await tool.handler({ session_id: 's1', prompt: '  do it  ' })

  assert.equal(result.accepted, true)
  assert.equal(result.session_id, 's1')
  assert.equal(result.mode, 'queue')
  assert.equal(result.cursor_before, 7)
  assert.equal(result.wait, undefined)
  assert.deepEqual(calls.map(([name]) => name), ['state', 'prompt'])
  assert.equal(typeof calls[1][1].requestId, 'string')
  assert.deepEqual(calls[0][1], { sessionId: 's1' })
  assert.deepEqual(calls[1][1].content, [{ type: 'text', text: 'do it' }])
  assert.equal(calls[1][1].mode, 'queue')
})

test('dsh_send uses the configured default wait and passes afterSeq to wait', async () => {
  const { controller, calls } = makeSendController()
  const tool = createSendTool(controller, { defaultWaitMs: 2000 })
  const result = await tool.handler({ session_id: 's1', prompt: 'go' })
  assert.equal(result.wait.reason, 'idle')
  assert.equal(result.wait.latest_text, 'finished')
  assert.deepEqual(calls.at(-1)[1], {
    sessionId: 's1',
    timeoutMs: 2000,
    afterSeq: 7,
    maxMessages: 10,
  })
})

test('dsh_send supports steer and explicit wait_ms, and rejects illegal waits', async () => {
  const { controller, calls } = makeSendController()
  const tool = createSendTool(controller, {})

  await tool.handler({ session_id: 's1', prompt: 'change course', mode: 'steer', wait_ms: 1200 })
  assert.equal(calls[1][1].mode, 'steer')
  assert.equal(calls.at(-1)[1].timeoutMs, 1200)

  await assert.rejects(
    () => tool.handler({ session_id: 's1', prompt: 'x', wait_ms: 500 }),
    (error) => error.code === -32602 && /wait_ms/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', prompt: '   ' }),
    (error) => error.code === -32602 && /prompt/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', prompt: 'x', wait_ms: 25_001 }),
    (error) => error.code === -32602 && /at most 25000/.test(error.message),
  )
})

test('dsh_send forwards the client abort signal to state, prompt, and wait', async () => {
  const { controller, calls } = makeSendController()
  const tool = createSendTool(controller, {})
  const abort = new AbortController()
  await tool.handler({ session_id: 's1', prompt: 'x', wait_ms: 1000 }, { signal: abort.signal })
  for (const call of calls) assert.equal(call[2], abort.signal)
})

function waitValue(records, overrides = {}) {
  return {
    reason: 'idle',
    state: { cursor: 12, active: true, running: false, queue: [], pendingInput: [] },
    output: { truncated: false, records },
    ...overrides,
  }
}

function assistantRecord(seq, text, content = []) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        turn: 1,
        step: seq,
        message: { content: [{ type: 'text', text }, ...content] },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 },
      },
    },
  }
}

test('dsh_wait applies defaults, forwards after_seq, and summarizes newest-first records', async () => {
  const calls = []
  const controller = {
    async wait(request, signal) {
      calls.push([request, signal])
      return waitValue([
        assistantRecord(12, 'latest', [{ type: 'tool-call', id: 'c2', name: 'second', arguments: {} }]),
        assistantRecord(11, 'older', [{ type: 'tool-call', id: 'c1', name: 'first', arguments: {} }]),
      ])
    },
  }
  const tool = createWaitTool(controller)
  const signal = new AbortController().signal
  const result = await tool.handler({ session_id: 's1', after_seq: 10 }, { signal })

  assert.deepEqual(calls[0][0], { sessionId: 's1', timeoutMs: 45_000, afterSeq: 10, maxMessages: 10 })
  assert.equal(calls[0][1], signal)
  assert.equal(result.reason, 'idle')
  assert.equal(result.cursor, 12)
  assert.equal(result.latest_text, 'latest')
  assert.deepEqual(result.tool_calls.map((call) => call.name), ['first', 'second'])
  assert.equal(result.usage_delta.cache_hit_rate, 0.75)
})

test('dsh_wait honors timeout_ms and max_chars and truncates the latest text', async () => {
  const calls = []
  const controller = {
    async wait(request) {
      calls.push(request)
      return waitValue([assistantRecord(5, 'x'.repeat(120))], {
        reason: 'input-required',
        state: { cursor: 5, active: true, running: true, queue: [], pendingInput: ['approval'] },
      })
    },
  }
  const tool = createWaitTool(controller)
  const result = await tool.handler({ session_id: 's1', timeout_ms: 1000, max_chars: 100 })
  assert.equal(calls[0].timeoutMs, 1000)
  assert.equal(result.latest_text.length, 100)
  assert.ok(result.latest_text.endsWith('…'))
  assert.equal(result.text_truncated, true)
  assert.equal(result.pending_input[0], 'approval')
  assert.match(result.web_hint, /human/i)
})

test('dsh_wait rejects out-of-range timing budgets before calling the controller', async () => {
  const controller = { async wait() { throw new Error('must not be called') } }
  const tool = createWaitTool(controller)
  await assert.rejects(
    () => tool.handler({ session_id: 's1', timeout_ms: 999 }),
    (error) => error.code === -32602 && /at least 1000/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', timeout_ms: 120_001 }),
    (error) => error.code === -32602 && /at most 120000/.test(error.message),
  )
  await assert.rejects(
    () => tool.handler({ session_id: 's1', max_chars: 99 }),
    (error) => error.code === -32602 && /at least 100/.test(error.message),
  )
})

test('dsh_send describes whether the configured default waits', () => {
  const { controller } = makeSendController()

  const immediate = createSendTool(controller, {})
  assert.match(immediate.description, /immediate accepted response/)
  assert.match(immediate.inputSchema.properties.wait_ms.description, /0 returns immediately \(default\)/)

  const waiting = createSendTool(controller, { defaultWaitMs: 2000 })
  assert.match(waiting.description, /default 2000ms/)
  assert.match(waiting.inputSchema.properties.wait_ms.description, /waits 2000ms/)
})

test('dsh_wait attaches a failure diagnosis from the just-ended turn', async () => {
  const controller = {
    async wait() {
      return waitValue([])
    },
    async events() {
      return {
        records: [{
          type: 'event',
          event: {
            type: 'turn/end',
            seq: 12,
            time: 1,
            data: { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', status: 502, message: 'upstream 502' } } },
          },
        }],
      }
    },
  }
  const result = await createWaitTool(controller).handler({ session_id: 's1' })
  assert.equal(result.failure.category, 'service')
  assert.equal(result.failure.status, 502)
  assert.match(result.failure.hint, /continue/)
})
