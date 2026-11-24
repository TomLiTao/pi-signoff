import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectCheckStore, registerChecks, registerDiff } from './workflows.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-workflow-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harness() {
  const commands = new Map();
  const notes = [];
  const ctx = { cwd: process.cwd(), hasUI: true, ui: { notify: text => notes.push(text) } };
  return { pi: { registerCommand: (name, command) => commands.set(name, command.handler) }, commands, ctx, notes };
}

test('check definitions persist outside the workspace and never follow symlinks', t => {
  const base = fixture(t);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const store = projectCheckStore(base, a);
  assert.throws(() => projectCheckStore(a, a), /outside/);
  store.set('test', 'npm test -- --example');
  assert.throws(() => store.set('../escape', 'true'), /check name/);
  assert.deepEqual(projectCheckStore(base, a).names(), ['test']);
  assert.equal(projectCheckStore(base, a).get('test'), 'npm test -- --example');
  assert.equal(projectCheckStore(base, b).get('test'), undefined);
  const storage = path.join(base, 'project-checks');
  const [entry] = readdirSync(storage);
  const outside = path.join(base, 'other');
  writeFileSync(outside, 'false', { mode: 0o600 });
  rmSync(path.join(storage, entry));
  symlinkSync(outside, path.join(storage, entry));
  assert.throws(() => store.get('test'), { code: 'ELOOP' });
  store.remove('test');
  assert.equal(store.get('test'), undefined);
});

test('user and model checks use the same job entry point and saving does not run or approve', async t => {
  const dir = fixture(t);
  const { pi, commands, ctx, notes } = harness();
  const calls = [];
  const run = registerChecks(pi, dir, {
    async startCheck(name, command, ctx, model) {
      calls.push({ name, command, model });
      if (command === 'false') throw new Error('Shell command not approved.');
      return { id: calls.length };
    },
  });
  const testCommand = args => commands.get('test')(args, ctx);
  await testCommand('rerun');
  assert.match(notes.at(-1), /No check has started/);
  await testCommand('set test npm test');
  await testCommand('set lint false');
  assert.equal(calls.length, 0);
  assert.match(await run('list', ctx), /lint, test/);
  await testCommand('');
  assert.match(notes.at(-1), /test \(job 1\)/);
  assert.match(await run('test', ctx), /test \(job 2\)/);
  await testCommand('lint');
  assert.match(notes.at(-1), /not approved/);
  await testCommand('rerun');
  assert.deepEqual(calls, [
    { name: 'test', command: 'npm test', model: false },
    { name: 'test', command: 'npm test', model: true },
    { name: 'lint', command: 'false', model: false },
    { name: 'test', command: 'npm test', model: false },
  ]);
  await testCommand('remove test');
  await assert.rejects(run('test', ctx), /No named check test/);
  await assert.rejects(run('lint', { ...ctx, cwd: dir }), /launch folder/);
});

test('diff fails closed without a launch checkpoint', async t => {
  const { pi, commands, ctx, notes } = harness();
  registerDiff(pi, fixture(t), undefined);
  await commands.get('diff')('', ctx);
  assert.match(notes.at(-1), /No Git checkpoint was created at launch/);
});

test('/review delegates untrusted patch on stdin with bugs-first prompt, supports --since, and splits >200 KB diffs by directory', async t => {
  const dir = fixture(t);
  const { pi, commands, ctx, notes } = harness();
  const branch = [{ type: 'message', id: 'm1' }];
  ctx.sessionManager = { getBranch: () => branch };
  ctx.model = { provider: 'local', id: 'test-model' };

  const delegated = [];
  let slots = 2;
  const mockDiffs = new Map();

  const { FIXED_REVIEW_PROMPT, REVIEW_PATCH_CAP_BYTES, registerReview } = await import('./workflows.ts');
  assert.ok(FIXED_REVIEW_PROMPT.indexOf('Bugs') < FIXED_REVIEW_PROMPT.indexOf('Risky changes'));

  registerReview(
    pi,
    dir,
    'refs/pi-protected-checkpoints/launch-11111111',
    {
      availableSlots: () => slots,
      startReadOnlyDelegateJob(label, fullTask, _ctx, stdinData) {
        const id = delegated.length + 1;
        delegated.push({ id, label, fullTask, stdinData });
        return { id };
      },
    },
    turn => (turn === 2 ? 'refs/pi-protected-checkpoints/turn2-22222222' : undefined),
    async args => {
      const [_launch, ref, limit, targetPath] = args;
      assert.equal(Number(limit), REVIEW_PATCH_CAP_BYTES);
      const key = `${ref}:${targetPath ?? '*'}`;
      return mockDiffs.get(key) ?? { patch: '', truncated: false };
    },
  );

  const reviewCmd = raw => commands.get('review')(raw, ctx);

  // 1. Empty diff -> nothing spawned
  await reviewCmd('');
  assert.equal(delegated.length, 0);
  assert.match(notes.at(-1), /no checkpointed file changes/i);

  // 2. Normal diff against launch checkpoint -> single read-only delegate with patch on stdin
  mockDiffs.set('refs/pi-protected-checkpoints/launch-11111111:*', {
    patch: 'diff --git a/app.ts b/app.ts\n+const bug = 1;\n',
    truncated: false,
  });
  await reviewCmd('');
  assert.equal(delegated.length, 1);
  assert.equal(delegated[0].label, 'review:workspace');
  assert.equal(delegated[0].fullTask, FIXED_REVIEW_PROMPT);
  assert.match(delegated[0].stdinData, /\+const bug = 1;/);

  // 3. --since <turn> resolves turn checkpoint
  mockDiffs.set('refs/pi-protected-checkpoints/turn2-22222222:*', {
    patch: 'diff --git a/turn2.ts b/turn2.ts\n+turn2();\n',
    truncated: false,
  });
  await reviewCmd('--since 2');
  assert.equal(delegated.length, 2);
  assert.equal(delegated[1].label, 'review:since-turn-2');
  assert.match(delegated[1].stdinData, /\+turn2\(\);/);

  // Unknown --since turn fails cleanly
  await reviewCmd('--since 99');
  assert.match(notes.at(-1), /No file checkpoint recorded for turn 99/);

  // 4. Over 200 KB cap -> splits by directory up to availableSlots and lists remaining
  delegated.length = 0;
  mockDiffs.set('refs/pi-protected-checkpoints/launch-11111111:*', {
    patch: 'x'.repeat(REVIEW_PATCH_CAP_BYTES),
    truncated: true,
    groups: ['alpha', 'beta', 'gamma'],
  });
  mockDiffs.set('refs/pi-protected-checkpoints/launch-11111111:alpha', {
    patch: 'diff --git a/alpha/a.ts b/alpha/a.ts\n+a\n',
    truncated: false,
  });
  mockDiffs.set('refs/pi-protected-checkpoints/launch-11111111:beta', {
    patch: 'diff --git a/beta/b.ts b/beta/b.ts\n+b\n',
    truncated: false,
  });
  await reviewCmd('');
  assert.equal(delegated.length, 2);
  assert.deepEqual(delegated.map(d => d.label), ['review:alpha', 'review:beta']);
  assert.match(notes.at(-1), /Exceeds 200 KB/i);
  assert.match(notes.at(-1), /gamma/);
});
