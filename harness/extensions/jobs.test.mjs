import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkResultEntry, createJobPool, registerJobs } from './jobs.ts';

const invocation = script => ({ file: process.execPath, args: ['-e', script], env: process.env });
const cwd = process.cwd();

test('job pool runs multiple children, bounds output and captures failures', async () => {
  const pool = createJobPool(() => {});
  try {
    const a = pool.start('shell', 'a', cwd, invocation('console.log("start" + "a".repeat(20000) + "end")'), 5000);
    const b = pool.start('delegate', 'b', cwd, invocation('console.error("failed check"); process.exitCode = 42'), 5000);
    assert.ok(pool.hasActiveJobs());
    const c = pool.start('shell', 'c', cwd, invocation('setInterval(() => {}, 1000)'), 5000);
    assert.throws(() => pool.start('shell', 'd', cwd, invocation(''), 5000), /Three jobs/);
    await Promise.all([a.finished, b.finished]);
    assert.equal(a.state, 'done');
    assert.equal(a.truncated, true);
    assert.equal(a.output.length, 16 * 1024);
    assert.match(a.output.toString(), /end\n$/);
    assert.equal(b.state, 'failed');
    assert.equal(b.exit, 'exit 42');
    assert.match(b.output.toString(), /failed check/);
    assert.equal(pool.cancel(c), true);
    await c.finished;
    assert.equal(c.state, 'cancelled');
    assert.equal(pool.hasActiveJobs(), false);
  } finally { await pool.shutdown(); }
});

test('job timeouts, spawn failures, and shutdown clean up the pool', async () => {
  const pool = createJobPool(() => {});
  const timeout = pool.start('shell', 'timeout', cwd, invocation('setInterval(() => {}, 1000)'), 50);
  const missing = pool.start('delegate', 'missing', cwd, { file: '/no-such-pi-test-executable', args: [], env: process.env }, 1000);
  await Promise.all([timeout.finished, missing.finished]);
  assert.equal(timeout.state, 'timed out');
  assert.equal(missing.state, 'failed');
  const last = pool.start('delegate', 'shutdown', cwd, invocation('setInterval(() => {}, 1000)'), 5000);
  await pool.shutdown();
  assert.equal(last.state, 'cancelled');
  assert.throws(() => pool.start('shell', 'late', cwd, invocation(''), 1000), /closing/);
});

test('commands preserve plan policy, constrain delegate arguments and only share on request', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-job-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const commands = new Map();
  const hooks = new Map();
  const notifications = [];
  const sent = [];
  let inPlan = true;
  const pool = registerJobs({
    registerCommand: (name, command) => commands.set(name, command.handler),
    on: (name, handler) => hooks.set(name, handler),
    getActiveTools: () => ['pi_safe_read', 'pi_safe_write', 'pi_safe_web_fetch', 'other'],
    getThinkingLevel: () => 'low',
    sendMessage: (...args) => sent.push(args),
  }, { dir, isPlanning: () => inPlan, authorizeShell: async () => { throw new Error('not approved'); },
    shell: () => invocation('console.log("log\\x1b[2J")') });
  t.after(() => hooks.get('session_shutdown')());
  const ctx = { cwd, hasUI: true, model: { id: 'test-model', provider: 'test-provider' },
    ui: { notify: msg => notifications.push(msg), setStatus() {} } };
  await commands.get('bg')('touch file', ctx);
  assert.match(notifications.at(-1), /Plan mode/);
  assert.equal(pool.list().length, 0);
  await commands.get('delegate')('@secret-file --other-argument', ctx);
  const worker = pool.list()[0];
  await worker.finished;
  assert.equal(worker.state, 'done', worker.output.toString());
  assert.deepEqual(JSON.parse(worker.output.toString()), ['--protected-worker', 'test-provider', 'test-model', 'low',
    '1', 'pi_safe_read,pi_safe_web_fetch', '@secret-file --other-argument']);
  assert.equal(sent.length, 0);
  inPlan = false;
  await commands.get('bg')('npm test', ctx);
  await pool.list()[1].finished;
  await commands.get('job')('2', ctx);
  assert.match(notifications.at(-1), /log\\u\{1b\}\[2J/);
  await commands.get('job')('share 2', ctx);
  assert.equal(sent[0][1].deliverAs, 'nextTurn');
  for (const id of [1, 2]) {
    assert.throws(() => pool.modelOutput(id, ctx), /No model-started/);
    assert.throws(() => pool.cancelModelShell(id, ctx), /No model-started/);
  }
});

test('model shell jobs require authorization for the exact command and can be inspected or cancelled', async t => {
  const hooks = new Map();
  const seen = [];
  const saved = [];
  const pool = registerJobs({ registerCommand() {}, on: (name, handler) => hooks.set(name, handler),
    appendEntry: (...args) => saved.push(args) }, {
    dir: cwd, isPlanning: () => false,
    authorizeShell: async command => {
      seen.push(command);
      if (command !== 'long-check ') throw new Error('not approved');
    },
    shell: command => {
      assert.equal(command, 'long-check ');
      return seen.length < 3 ? invocation('setInterval(() => {}, 1000)') : invocation('console.log("checks passed")');
    },
  });
  t.after(() => hooks.get('session_shutdown')());
  let branch = [{ id: 'first' }];
  const ctx = { cwd, hasUI: false, sessionManager: { getLeafId: () => branch.at(-1).id, getBranch: () => branch } };
  await assert.rejects(pool.startModelShell('long-check', ctx), /not approved/);
  assert.equal(pool.list().length, 0);
  await assert.rejects(pool.startModelShell('long-check ', ctx, AbortSignal.abort()), /cancelled/);
  assert.match(await pool.startModelShell('long-check ', ctx), /job 1/);
  assert.deepEqual(seen, ['long-check', 'long-check ']);
  assert.match(pool.modelOutput(1, ctx), /running/);
  assert.match(pool.cancelModelShell(1, ctx), /Cancelling/);
  await pool.get(1).finished;
  assert.match(pool.modelOutput(1, ctx), /cancelled/);
  const check = await pool.startCheck('lint', 'long-check ', ctx, true);
  await check.finished;
  assert.match(pool.modelOutput(check.id, ctx), /\(lint\): passed \(exit 0\) · \d+\.\d+s\nchecks passed/);
  assert.deepEqual(saved, [[checkResultEntry, { name: 'lint', outcome: 'passed', elapsedMs: check.elapsedMs }]]);
  const unrelated = await pool.startCheck('lint', 'long-check ', ctx, true);
  branch = [{ id: 'other' }];
  await unrelated.finished;
  assert.equal(saved.length, 1);
});

test('model-shell jobs emit one-shot followUp completion notices while /bg and delegates stay private, plus --with-context preview', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-job-p5-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });

  const commands = new Map();
  const hooks = new Map();
  const followUps = [];
  const pool = registerJobs({
    registerCommand: (name, cmd) => commands.set(name, cmd.handler),
    on: (name, fn) => hooks.set(name, fn),
    getActiveTools: () => ['pi_safe_read', 'pi_safe_grep'],
    getThinkingLevel: () => 'low',
    sendMessage: (msg, opts) => followUps.push({ msg, opts }),
    appendEntry() {},
  }, {
    dir,
    isPlanning: () => false,
    authorizeShell: async () => {},
    shell: () => invocation('for (let i = 1; i <= 25; i++) console.log("line-" + i);'),
  });
  t.after(() => hooks.get('session_shutdown')());

  const branch = [
    { type: 'message', message: { role: 'user', content: 'Investigate auth timeout' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Found retry loop in client.ts' }] } },
  ];
  let previewPrompt = '';
  const ctx = {
    cwd,
    hasUI: true,
    model: { id: 'm1', provider: 'p1' },
    sessionManager: { getBranch: () => branch, getLeafId: () => '1' },
    ui: {
      notify() {},
      setStatus() {},
      select: async title => {
        previewPrompt = title;
        return 'Send with this summary';
      },
      editor: async (_t, s) => s,
    },
  };

  // 1. Model-started shell job emits exactly one job-done followUp with last 20 lines when idle
  await pool.startModelShell('pytest -q', ctx);
  await pool.get(1).finished;
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].msg.customType, 'job-done');
  assert.deepEqual(followUps[0].opts, { deliverAs: 'followUp', triggerTurn: true });
  assert.match(followUps[0].msg.content, /line-25/);
  assert.doesNotMatch(followUps[0].msg.content, /\bline-5\n/);

  // 1b. If a model-shell job finishes mid-turn AND pi_safe_job_status (modelOutput) already read its terminal output,
  //     agent_settled MUST NOT fire a redundant duplicate job-done follow-up turn!
  hooks.get('before_agent_start')();
  await pool.startModelShell('pytest -q fast-polled', ctx);
  await pool.get(2).finished;
  assert.equal(followUps.length, 1, 'deferred while turn is active');
  assert.match(pool.modelOutput(2, ctx), /line-25/);
  hooks.get('agent_settled')();
  assert.equal(followUps.length, 1, 'suppressed because modelOutput already observed terminal state');

  // 1c. Conversely, if a model-shell job finishes mid-turn and modelOutput was NOT called, agent_settled flushes job-done!
  hooks.get('before_agent_start')();
  await pool.startModelShell('pytest -q fast-unpolled', ctx);
  await pool.get(3).finished;
  assert.equal(followUps.length, 1);
  hooks.get('agent_settled')();
  assert.equal(followUps.length, 2, 'flushed on agent_settled when not polled');

  // 2. User /bg and model/user delegates do NOT emit job-done followUps
  await commands.get('bg')('echo private', ctx);
  await pool.get(4).finished;
  const delOut = await pool.runModelDelegate('inspect module', ctx);
  assert.match(delOut, /Read-only delegate 5 \(done/);
  assert.equal(followUps.length, 2);

  // 3. /delegate --with-context previews summary (never raw transcript) and passes approved summary
  await commands.get('delegate')('--with-context check edge cases', ctx);
  await pool.get(6).finished;
  assert.match(previewPrompt, /Investigate auth timeout/);
  const passedArgs = JSON.parse(pool.get(6).output.toString('utf8'));
  assert.match(passedArgs.at(-1), /Approved conversation summary:/);
  assert.match(passedArgs.at(-1), /Task:\ncheck edge cases/);
});

test('runModelWorktreeDelegate and /delegate --droid route specialized droids and capture isolated worktree diffs', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-job-wt-'));
  const wtBase = mkdtempSync(path.join(tmpdir(), 'pi-job-wt-cache-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  });
  writeFileSync(path.join(dir, 'pi'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });

  const oldWtEnv = process.env.PI_PROTECTED_WORKTREES_DIR;
  process.env.PI_PROTECTED_WORKTREES_DIR = wtBase;
  t.after(() => {
    if (oldWtEnv === undefined) delete process.env.PI_PROTECTED_WORKTREES_DIR;
    else process.env.PI_PROTECTED_WORKTREES_DIR = oldWtEnv;
  });

  const commands = new Map();
  const hooks = new Map();
  const { BUILTIN_DROIDS } = await import('./droids.ts');
  const pool = registerJobs({
    registerCommand: (name, cmd) => commands.set(name, cmd.handler),
    on: (name, fn) => hooks.set(name, fn),
    getActiveTools: () => ['pi_safe_read', 'pi_safe_grep', 'pi_safe_git'],
    getThinkingLevel: () => 'low',
    sendMessage() {},
    appendEntry() {},
  }, {
    dir,
    launchRef: 'refs/pi-protected-checkpoints/20261122-120000-abcdef12',
    writeRoot: cwd,
    isPlanning: () => false,
    resolveDroid: name => BUILTIN_DROIDS.find(d => d.name === name),
    authorizeShell: async () => {},
    shell: () => invocation(''),
    execCheckpoint: async args => {
      if (args[0] === 'export') {
        const dest = args[3];
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dest, { recursive: true, mode: 0o700 });
        return Buffer.from(`${dest}\n`);
      }
      if (args[0] === 'worktree-diff') {
        return Buffer.from('diff --git a/fix.ts b/fix.ts\n+export const ok = true;\n');
      }
      return Buffer.alloc(0);
    },
  });
  t.after(() => hooks.get('session_shutdown')());

  const ctx = {
    cwd,
    hasUI: true,
    model: { id: 'base-m', provider: 'base-p' },
    ui: { notify() {}, setStatus() {} },
  };

  // 1. /delegate --droid reviewer uses reviewer's high reasoning and read-only+bash tools
  await commands.get('delegate')('--droid reviewer Audit auth flow', ctx);
  await pool.get(1).finished;
  const revArgs = JSON.parse(pool.get(1).output.toString('utf8'));
  assert.equal(revArgs[0], '--protected-worker');
  assert.equal(revArgs[3], 'high');
  assert.match(revArgs[5], /pi_safe_bash/);
  assert.match(revArgs[6], /Subagent role: reviewer/);

  // 2. runModelWorktreeDelegate runs in isolated worktree and returns diff summary
  const wtOut = await pool.runModelWorktreeDelegate('Implement fix.ts', ctx, undefined, {
    thinking: 'medium',
    label: '[worker] Implement fix.ts',
  });
  assert.match(wtOut, /Isolated worktree delegate 2 \(done/);
  assert.match(wtOut, /Isolated worktree diff/);
  assert.match(wtOut, /\+export const ok = true;/);
  assert.match(wtOut, /\/delegate apply 2/);
});

test('waitModelOutput supports bounded waiting, concise running tail, abort signals, and duplicate job-done suppression', async t => {
  const hooks = new Map();
  const followUps = [];
  const pool = registerJobs({
    registerCommand() {},
    on: (name, fn) => hooks.set(name, fn),
    sendMessage: (msg, opts) => followUps.push({ msg, opts }),
    appendEntry() {},
  }, {
    dir: cwd,
    isPlanning: () => false,
    authorizeShell: async () => {},
    shell: () => invocation(
      'process.stdout.write(Array.from({ length: 40 }, (_, i) => "out-line-" + (i + 1)).join("\\n") + "\\n"); ' +
      'setTimeout(() => { console.log("DONE_MARKER"); }, 350);',
    ),
  });
  t.after(() => hooks.get('session_shutdown')());

  const ctx = { cwd, hasUI: false };
  hooks.get('before_agent_start')();
  await pool.startModelShell('pytest -q', ctx);

  // Give child process a brief moment to emit initial 40 lines while staying alive
  await new Promise(r => setTimeout(r, 60));

  // 1. Short wait returns concise running tail (omitting out-line-1, keeping out-line-40)
  const runningText = await pool.waitModelOutput(1, ctx, { waitMs: 20, runningTailLines: 10 });
  assert.match(runningText, /running/);
  assert.match(runningText, /\[Still running — showing recent output tail/);
  assert.match(runningText, /\[Earlier output omitted while running\]/);
  assert.doesNotMatch(runningText, /\bout-line-1\n/);
  assert.match(runningText, /out-line-40/);

  // 2. Aborting a wait rejects immediately without killing the running job
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 15);
  await assert.rejects(
    pool.waitModelOutput(1, ctx, { waitMs: 5000, signal: ac.signal }),
    /cancelled/,
  );
  assert.equal(pool.get(1).state, 'running');

  // 3. Waiting with ample budget resolves as soon as the job finishes and suppresses duplicate job-done followUp
  const t0 = Date.now();
  const doneText = await pool.waitModelOutput(1, ctx, { waitMs: 5000 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `resolved promptly on exit (${elapsed}ms)`);
  assert.match(doneText, /done \(exit 0\)/);
  assert.match(doneText, /out-line-1\n/);
  assert.match(doneText, /DONE_MARKER/);

  hooks.get('agent_settled')();
  assert.equal(followUps.length, 0, 'terminal observation via waitModelOutput suppresses duplicate job-done notice');
});
