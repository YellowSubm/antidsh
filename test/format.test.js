import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  aggregateUsage,
  assistantRecordSummary,
  blocksText,
  compactWait,
  summarizeEvent,
  toolCallsOf,
  truncateText,
} from '../src/format.js'

function assistant(seq, text, options = {}) {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        turn: 1,
        step: seq,
        message: { id: `m${String(seq)}`, role: 'assistant', content: [{ type: 'text', text }, ...(options.content ?? [])] },
        usage: options.usage,
      },
    },
  }
}

test('truncateText counts Unicode code points and marks the cut', () => {
  assert.deepEqual(truncateText('hello', 10), { text: 'hello', truncated: false })
  assert.deepEqual(truncateText('a😀b', 2), { text: 'a…', truncated: true })
  assert.deepEqual(truncateText('abc', 0), { text: '', truncated: true })
})

test('blocksText joins text blocks and ignores non-text content', () => {
  const text = blocksText([
    { type: 'text', text: 'first' },
    { type: 'image', data: 'ignored' },
    { type: 'text', text: 'second' },
  ])
  assert.equal(text, 'first\nsecond')
})

test('toolCallsOf extracts tool-call blocks with bounded arguments', () => {
  const calls = toolCallsOf({
    content: [
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: { path: 'a.js' } },
      { type: 'text', text: 'ignored' },
    ],
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.equal(calls[0].call_id, 'call_1')
  assert.match(calls[0].arguments, /a\.js/)
})

test('aggregateUsage sums mutually exclusive counters and computes cache hit rate', () => {
  const usage = aggregateUsage([
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, totalTokens: 420 },
    { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0 },
  ])
  assert.equal(usage.input_tokens, 100)
  assert.equal(usage.output_tokens, 25)
  assert.equal(usage.cache_read_tokens, 300)
  assert.equal(usage.cache_hit_rate, 0.75)
  assert.equal(usage.messages, 2)
})

test('aggregateUsage falls back to every counter when totalTokens is absent', () => {
  const usage = aggregateUsage([{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 3 }])
  assert.equal(usage.total_tokens, 38)
})

test('aggregateUsage returns null instead of NaN when the denominator is zero', () => {
  const usage = aggregateUsage([{ inputTokens: 0, outputTokens: 12, cacheReadTokens: 0 }])
  assert.equal(usage.cache_hit_rate, null)
  assert.equal(aggregateUsage([]).cache_hit_rate, null)
  assert.equal(aggregateUsage([]).messages, 0)
})

test('summarizeEvent compacts assistant, tool call, and tool result events', () => {
  const summary = summarizeEvent(assistant(3, 'Working on it', {
    content: [{ type: 'tool-call', id: 'call_9', name: 'shell', arguments: { command: 'ls' } }],
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 30 },
  }), 100)
  assert.equal(summary.type, 'assistant')
  assert.equal(summary.seq, 3)
  assert.equal(summary.text, 'Working on it')
  assert.equal(summary.tool_calls[0].name, 'shell')
  assert.equal(summary.usage.cache_hit_rate, 0.75)

  const call = summarizeEvent({
    type: 'event',
    event: { type: 'tool/call', seq: 4, time: 1, data: { turn: 1, step: 2, callId: 'call_9', name: 'shell', arguments: { command: 'ls' } } },
  })
  assert.equal(call.type, 'tool_call')
  assert.equal(call.call_id, 'call_9')

  const result = summarizeEvent({
    type: 'event',
    event: {
      type: 'tool/result',
      seq: 5,
      time: 1,
      data: {
        turn: 1,
        step: 2,
        message: { content: [{ type: 'text', text: 'ok' }], toolCallId: 'call_9', isError: false },
      },
    },
  })
  assert.equal(result.type, 'tool_result')
  assert.equal(result.text, 'ok')
  assert.equal(result.is_error, false)
})

test('compactWait restores chronological tool calls and reports the latest text', () => {
  const value = {
    reason: 'idle',
    state: { cursor: 9, active: true, running: false, queue: [], pendingInput: [] },
    output: {
      truncated: false,
      records: [
        assistant(2, 'done', {
          content: [{ type: 'tool-call', id: 'c2', name: 'second', arguments: {} }],
          usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 5 },
        }),
        assistant(1, 'thinking', {
          content: [{ type: 'tool-call', id: 'c1', name: 'first', arguments: {} }],
        }),
      ],
    },
  }
  const compact = compactWait(value, { maxChars: 50 })
  assert.equal(compact.reason, 'idle')
  assert.equal(compact.cursor, 9)
  assert.equal(compact.latest_text, 'done')
  assert.equal(compact.latest_seq, 2)
  assert.deepEqual(compact.tool_calls.map((call) => call.name), ['first', 'second'])
  assert.equal(compact.usage_delta.cache_hit_rate, 0.5)
  assert.match(compact.web_hint, /idle/i)
})

test('compactWait truncates the latest text and reports partial records', () => {
  const compact = compactWait({
    reason: 'timeout',
    state: { cursor: 1, active: false, running: true, queue: [{ id: 'q' }], pendingInput: ['question'] },
    output: { truncated: true, records: [assistant(1, 'abcdefghij')] },
  }, { maxChars: 5 })
  assert.equal(compact.latest_text, 'abcd…')
  assert.equal(compact.text_truncated, true)
  assert.equal(compact.pending_input[0], 'question')
  assert.equal(compact.queue_length, 1)
  assert.match(compact.web_hint, /still be running/i)
})

test('assistantRecordSummary keeps usage and tool calls in one read', () => {
  const summary = assistantRecordSummary(assistant(1, 'hi', {
    content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: { path: 'x' } }],
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
  }))
  assert.equal(summary.text, 'hi')
  assert.equal(summary.tool_calls[0].name, 'read')
  assert.equal(summary.usage.cache_read_tokens, 3)
})
