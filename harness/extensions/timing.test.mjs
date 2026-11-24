import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTiming } from './timing.ts';

test('timing records separate provider attempts, streaming milestones and overlapping tool spans', () => {
  const handlers = new Map();
  const rows = [];
  let now = 100;
  registerTiming({ on: (name, handler) => handlers.set(name, handler) },
    row => rows.push(row), () => now);
  function at(ms, name, event = {}) {
    now = 100 + ms;
    handlers.get(name)(event, { model: { provider: 'provider', id: 'model' } });
  }
  at(1, 'before_agent_start', { prompt: 'secret' });
  at(2, 'turn_start', { turnIndex: 1 });
  at(3, 'before_provider_request', { payload: 'secret' });
  at(4, 'after_provider_response', { status: 429, headers: { key: 'secret' } });
  at(10, 'before_provider_request');
  at(14, 'after_provider_response', { status: 200 });
  at(16, 'provider_stream_event', { data: 'secret' });
  at(17, 'message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' } });
  at(20, 'message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' } });
  at(21, 'message_update', { assistantMessageEvent: { type: 'text_delta', delta: '' } });
  at(22, 'message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'secret' } });
  at(23, 'message_update', { assistantMessageEvent: { type: 'toolcall_end' } });
  at(24, 'message_end', { message: { role: 'assistant', stopReason: 'toolUse' } });
  at(25, 'tool_execution_start', { toolCallId: '1', toolName: 'first', args: 'secret' });
  at(26, 'tool_execution_start', { toolCallId: '2', toolName: 'second' });
  at(28, 'tool_execution_end', { toolCallId: '2', durationMs: 2, result: 'secret' });
  at(30, 'agent_settled', { aborted: true });

  assert.deepEqual(rows.slice(1, 3).map(row => [row.id, row.outcome, row.headers, row.firstStreamAtMs, row.firstOutputAtMs]), [
    [1, 'superseded', [{ atMs: 4, status: 429 }], undefined, {}],
    [2, 'toolUse', [{ atMs: 14, status: 200 }], 16, { thinking: 17, text: 22, tool: 23 }],
  ]);
  assert.deepEqual(rows.slice(3, 5).map(row => [row.tool, row.startedAtMs, row.endedAtMs, row.outcome]), [
    ['second', 26, 28, 'ok'], ['first', 25, 30, 'aborted'],
  ]);
  assert.deepEqual(rows.at(-1), { kind: 'run_end', run: 1, atMs: 30, aborted: true });
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
});
