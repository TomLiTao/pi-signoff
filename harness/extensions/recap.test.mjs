import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecap, registerRecap } from './recap.ts';
import { checkResultEntry } from './jobs.ts';

const msg = (role, content, stopReason) => ({ type: 'message', message: { role, content, stopReason } });
const text = text => ({ type: 'text', text });
const request = msg('user', [text('Fix the parser\nfirst.\u001b'), { type: 'image', data: 'private image bytes' }]);
const reply = msg('assistant', [{ type: 'thinking', thinking: 'hidden reasoning' }, text('Parser updated.')], 'stop');
const toolCall = msg('assistant', [text('Interim tool chatter')], 'toolUse');

test('recap uses excerpts from the branch and labels an unanswered request', () => {
  const branch = [reply, request, toolCall, msg('toolResult', [text('raw log')])];
  const report = buildRecap(branch, undefined, 0);
  assert.match(report, /Last request: Fix the parser first\./);
  assert.match(report, /Earlier reply: Parser updated\./);
  assert.match(report, /No final reply to the last request yet/);
  assert.doesNotMatch(report, /hidden reasoning|raw log|private image bytes|Interim|\u001b/);
  assert.match(buildRecap([request, reply], undefined, 1), /Last reply: Parser updated\.\nJobs: 1 active/);
  const long = buildRecap([msg('user', 'x'.repeat(300))], undefined, 0);
  assert.match(long, /x{239}…/);
});

test('recap shows open steps and only validated historical check metadata', () => {
  const result = { type: 'custom', customType: checkResultEntry, timestamp: '2025-06-01T01:02:03Z',
    data: { name: 'lint', outcome: 'passed', elapsedMs: 1234, command: 'secret command', output: 'secret output' } };
  const newer = { ...result, data: { ...result.data, outcome: 'not a status' } };
  const steps = Array.from({ length: 5 }, (_, i) => ({ step: i + 1, text: `Step ${i + 1}`, completed: i === 0 }));
  const report = buildRecap([request, result, newer], { mode: 'execute', steps }, 0);
  assert.match(report, /Active plan: execution · 1\/5 steps marked done/);
  assert.match(report, /2\. Step 2[\s\S]*1 more; see \/plan:status/);
  assert.match(report, /lint — passed in 1\.2s \(recorded, 2025-06-01 01:02 UTC; not rerun\)/);
  assert.doesNotMatch(report, /Step 1|Step 5|secret|not a status/);
  assert.match(report, /Jobs from previous sessions do not resume/);
});

test('recap is automatic only on existing terminal sessions and can be requested manually', async () => {
  const commands = new Map();
  const hooks = new Map();
  const notes = [];
  registerRecap({ registerCommand: (name, command) => commands.set(name, command.handler),
    on: (name, handler) => hooks.set(name, handler) }, { plan: () => undefined, activeJobs: () => 0 });
  let entries = [];
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getBranch: () => entries },
    ui: { notify: text => notes.push(text) } };
  const start = hooks.get('session_start');
  start({ reason: 'startup' }, ctx);
  entries = [request];
  start({ reason: 'new' }, ctx);
  start({ reason: 'resume' }, { ...ctx, mode: 'rpc' });
  assert.deepEqual(notes, []);
  start({ reason: 'resume' }, ctx);
  start({ reason: 'startup' }, ctx);
  await commands.get('recap')('', ctx);
  assert.equal(notes.length, 3);
  assert.ok(notes.every(note => note.startsWith('Session recap')));
});
