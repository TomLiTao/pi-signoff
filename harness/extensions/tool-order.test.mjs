import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalToolOrder, keepToolOrderStable } from './tool-order.ts';

/** A pi stand-in that, like Pi, keeps the active list in exactly the order it is given. */
function fakePi(registry, launchOrder) {
  const handlers = new Map();
  let active = [...launchOrder];
  const prompts = [];
  return {
    pi: {
      getAllTools: () => registry.map(name => ({ name })),
      getActiveTools: () => [...active],
      setActiveTools(names) { active = [...names]; prompts.push(active.join(',')); },
      on: (event, fn) => handlers.set(event, fn),
    },
    handlers,
    prompts,
    active: () => active,
  };
}

const registry = ['read', 'bash', 'edit', 'write', 'grep', 'plan', 'run_start', 'run_status', 'web_search'];
const planTools = new Set(['read', 'bash', 'grep', 'plan', 'web_search']);

test('a plan-mode round trip restores the exact original tool order', async () => {
  const f = fakePi(registry, registry);
  keepToolOrderStable(f.pi);
  await f.handlers.get('session_start')();
  const before = f.active().join(',');
  // What pi-plan does: filter to plan tools, then set the normal list back with the removed tools appended.
  f.pi.setActiveTools(f.active().filter(n => planTools.has(n)));
  f.pi.setActiveTools([...f.active(), 'edit', 'write', 'run_start', 'run_status']);
  assert.equal(f.active().join(','), before);
});

test('without the wrapper the same round trip reorders the prompt (the bug)', () => {
  const f = fakePi(registry, registry);
  f.pi.setActiveTools(f.active().filter(n => planTools.has(n)));
  f.pi.setActiveTools([...f.active(), 'edit', 'write', 'run_start', 'run_status']);
  assert.notEqual(f.active().join(','), registry.join(','));
});

test('session start settles a launch order that differs from registry order, and only when needed', async () => {
  const launch = ['read', 'bash', 'grep', 'edit', 'write', 'plan', 'web_search', 'run_start', 'run_status'];
  const f = fakePi(registry, launch);
  keepToolOrderStable(f.pi);
  await f.handlers.get('session_start')();
  assert.deepEqual(f.active(), registry);
  const calls = f.prompts.length;
  await f.handlers.get('session_start')();
  assert.equal(f.prompts.length, calls, 'already ordered: no extra prompt rebuild');
});

test('unknown names keep their relative order after registered ones; duplicates collapse', () => {
  assert.deepEqual(canonicalToolOrder(['mcp_b', 'write', 'mcp_a', 'read', 'write'], registry), ['read', 'write', 'mcp_b', 'mcp_a']);
});

test('a read-only API object is left alone', () => {
  const pi = Object.freeze({ setActiveTools() {}, getAllTools: () => [], getActiveTools: () => [], on() { throw new Error('should not register'); } });
  assert.doesNotThrow(() => keepToolOrderStable(pi));
});
