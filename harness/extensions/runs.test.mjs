import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_RUN_HOURS, registerRuns } from './runs.ts';

function harness(script, extra = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'pi-runs-'));
  const tools = new Map();
  const messages = [];
  const handlers = new Map();
  const pi = {
    registerTool: t => tools.set(t.name, t),
    on: (name, fn) => handlers.set(name, fn),
    sendMessage: (msg, opts) => messages.push({ msg, opts }),
  };
  const confirms = [];
  const handle = registerRuns(pi, {
    authorize: async () => ({ prompted: false }),
    confirm: async (_ctx, action, value) => { confirms.push({ action, value }); return extra.approve ?? true; },
    beforeRun: async () => true,
    invocation: command => ({ file: '/bin/sh', args: ['-c', script ?? command], env: process.env }),
    blockedReason: () => extra.blocked,
    stateDir,
    pollMs: 100,
  });
  const ctx = { cwd: stateDir, hasUI: true, ui: { notify() {} } };
  const call = (name, params) => tools.get(name).execute('id', params, undefined, undefined, ctx);
  return { stateDir, tools, handlers, messages, confirms, handle, call, ctx, cleanup() { handle.stop(); rmSync(stateDir, { recursive: true, force: true }); } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('detached run finishes, records its exit code and is announced once', async () => {
  const h = harness('echo hello; echo done; exit 3');
  try {
    const out = await h.call('pi_safe_run_start', { command: 'python3 solve.py', maxHours: 1, label: 'unit' });
    const id = out.content[0].text.match(/run (r\S+)/)[1];
    assert.equal(h.confirms.length, 1);
    assert.match(h.confirms[0].action, /stops after 1 h/);
    await sleep(800);
    const status = (await h.call('pi_safe_run_status', { id })).content[0].text;
    assert.match(status, /finished, exit 3/);
    assert.match(status, /done/);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].msg.customType, 'run-done');
    assert.equal(h.messages[0].opts.deliverAs, 'followUp');
    await sleep(300);
    assert.equal(h.messages.length, 1, 'announced only once');
    const list = (await h.call('pi_safe_run_status', {})).content[0].text;
    assert.match(list, new RegExp(id));
    const rec = JSON.parse(readFileSync(path.join(h.stateDir, id, 'run.json'), 'utf8'));
    assert.equal(rec.limitSeconds, 3600);
  } finally {
    h.cleanup();
  }
});

test('cancel stops the whole process group and denial or plan mode blocks start', async () => {
  const h = harness('sleep 30');
  try {
    const out = await h.call('pi_safe_run_start', { command: 'long' });
    const id = out.content[0].text.match(/run (r\S+)/)[1];
    await sleep(200);
    assert.match((await h.call('pi_safe_run_status', { id })).content[0].text, /running/);
    await h.call('pi_safe_run_cancel', { id });
    await sleep(500);
    assert.match((await h.call('pi_safe_run_status', { id })).content[0].text, /cancelled/);
  } finally {
    h.cleanup();
  }
  const denied = harness('true', { approve: false });
  try {
    await assert.rejects(denied.call('pi_safe_run_start', { command: 'x' }), /not approved/);
  } finally {
    denied.cleanup();
  }
  const plan = harness('true', { blocked: 'Detached runs are unavailable in plan mode.' });
  try {
    await assert.rejects(plan.call('pi_safe_run_start', { command: 'x' }), /plan mode/);
  } finally {
    plan.cleanup();
  }
  assert.equal(MAX_RUN_HOURS, 24);
});

/** A ctx that throws like Pi's once its session is replaced or reloaded. */
function staleableCtx(cwd) {
  const state = { stale: false };
  const guard = value => { if (state.stale) throw new Error('This extension ctx is stale after session replacement or reload.'); return value; };
  const ctx = { get cwd() { return guard(cwd); }, get hasUI() { return guard(true); }, get ui() { return guard({ notify() {} }); } };
  return { ctx, state };
}

test('session shutdown stops polling, so a stale ctx is never read', async () => {
  const h = harness('sleep 0.3');
  const { ctx, state } = staleableCtx(h.stateDir);
  try {
    await h.tools.get('pi_safe_run_start').execute('id', { command: 'x' }, undefined, undefined, ctx);
    const shutdown = h.handlers.get('session_shutdown');
    assert.equal(typeof shutdown, 'function', 'registers a session_shutdown handler');
    await shutdown({ type: 'session_shutdown', reason: 'reload' }, ctx);
    state.stale = true;
    await sleep(700);
    assert.equal(h.messages.length, 0, 'the old session announces nothing after shutdown');
  } finally {
    h.cleanup();
  }
});

test('a stale ctx does not crash the poller and the run is announced in the next session', async () => {
  const h = harness('true');
  const { ctx, state } = staleableCtx(h.stateDir);
  try {
    await h.tools.get('pi_safe_run_start').execute('id', { command: 'x' }, undefined, undefined, ctx);
    state.stale = true; // replaced without a shutdown event reaching this instance
    await sleep(400); // several polls against the stale ctx
    assert.equal(h.messages.length, 0);
    await h.handlers.get('session_start')({ type: 'session_start' }, h.ctx);
    assert.equal(h.messages.length, 1, 'announced once a live ctx arrives');
    assert.equal(h.messages[0].opts.deliverAs, 'nextTurn');
  } finally {
    h.cleanup();
  }
});
