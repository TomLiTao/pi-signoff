import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionsRequest, registerSessions } from './sessions.ts';

test('pi_safe_sessions validates requests and pins the project folder to the session cwd', async () => {
  const req = JSON.parse(buildSessionsRequest('/p', { action: 'search', query: 'febio', agent: 'codex', limit: 5 }));
  assert.deepEqual(req, { cwd: '/p', action: 'search', agent: 'codex', query: 'febio', limit: 5 });
  assert.equal(JSON.parse(buildSessionsRequest('/p', {})).action, 'list');
  for (const bad of [{ action: 'read' }, { agent: 'grok' }, { action: 'digest' }, { action: 'digest', id: '../x' },
    { action: 'search', query: 'ab' }, { limit: 0 }, { limit: 500 }]) {
    assert.throws(() => buildSessionsRequest('/p', bad), undefined, JSON.stringify(bad));
  }
  let tool;
  const seen = [];
  registerSessions({ registerTool: t => { tool = t; } }, {
    dir: '/x', nodeHome: '/n', runRead: fn => fn(),
    run: async (cwd, request) => { seen.push([cwd, JSON.parse(request)]); return { code: 0, out: '3 sessions' }; },
  });
  const out = await tool.execute('id', { action: 'list', cwd: '/elsewhere' }, undefined, undefined, { cwd: '/proj' });
  assert.equal(seen[0][0], '/proj');
  assert.equal(seen[0][1].cwd, '/proj');
  assert.match(out.content[0].text, /3 sessions[\s\S]*untrusted/);
});
