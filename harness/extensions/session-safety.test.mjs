// Session-safety fixes: task-worktree guard, per-worktree checkpoints, approval timeouts, exit typos,
// old-image stubbing and turn-change attribution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWorktreeGuard, createsWorktree, lockState, lockWorktree, nestedWorktreeOf, nestedWorktreesFromPorcelain,
  unlockWorktree, linkedGitdir,
} from './worktree-guard.ts';
import { buildRewindTargets, checkpointEntryType, rootCheckpointEntryType } from './checkpoints.ts';
import { askApproval, lastApprovalMiss, shellNotApprovedMessage, APPROVAL_TIMEOUT_MS } from './approvals.ts';
import { EXIT_TYPO } from './exit-command.ts';
import { stubOldImages } from './read-images.ts';
import { formatTurnChanges } from './droid-ui-format.ts';

const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-C', cwd, ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });

function repoWithTaskWorktree(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-wt-guard-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  git(base, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(base, 'AGENTS.md'), 'Do each task in its own worktree.\n');
  git(base, 'add', '.');
  git(base, 'commit', '-qm', 'init');
  const task = path.join(base, '.claude', 'worktrees', 'task');
  git(base, 'worktree', 'add', '-q', '-b', 'pi/task', task, 'main');
  return { base, task };
}

test('a nested task worktree is found from any path inside it, including new files', t => {
  const { base, task } = repoWithTaskWorktree(t);
  assert.equal(nestedWorktreeOf(base, path.join(task, 'new', 'deep', 'file.md'))?.root, task);
  assert.equal(nestedWorktreeOf(base, path.join(base, 'docs', 'x.md')), undefined);
  assert.equal(nestedWorktreeOf(base, '/etc/passwd'), undefined);
  assert.ok(linkedGitdir(task));
  assert.equal(linkedGitdir(base), undefined);
});

test('the session lock stops git worktree remove, and a dead holder counts as stale', t => {
  const { base, task } = repoWithTaskWorktree(t);
  const gitdir = linkedGitdir(task);
  assert.ok(lockWorktree(gitdir, 'session-a'));
  assert.equal(lockState(gitdir).state, 'ours');
  assert.throws(() => git(base, 'worktree', 'remove', task), /locked/);
  // Another live Pi process (this test's parent) cannot take it; a dead one's lock is replaced.
  assert.equal(lockWorktree(gitdir, 'session-b', process.ppid), false);
  assert.equal(lockState(gitdir, process.ppid).state, 'live-pi');
  assert.ok(unlockWorktree(gitdir));
  writeFileSync(path.join(gitdir, 'locked'), 'pi session old (pid 999999999) is working in this worktree.\n');
  assert.equal(lockState(gitdir).state, 'stale-pi');
  assert.ok(lockWorktree(gitdir, 'session-c'));
  assert.match(lockState(gitdir).reason, /session-c/);
  // A lock that is not a Pi lock is never touched.
  unlockWorktree(gitdir);
  writeFileSync(path.join(gitdir, 'locked'), 'on a USB disk\n');
  assert.equal(lockWorktree(gitdir, 'session-d'), false);
  assert.equal(unlockWorktree(gitdir, process.pid, true), false);
});

test('a removed task worktree blocks main-checkout writes until the user decides, and shows in the plan review', async t => {
  const { base, task } = repoWithTaskWorktree(t);
  const notes = [];
  const ctx = { hasUI: true, ui: { notify: (m, level) => notes.push([level, m]) } };
  const guard = createWorktreeGuard({ launch: base, listWorktrees: async () => git(base, 'worktree', 'list', '--porcelain') });
  await guard.onSessionStart('sess-1', ctx);
  // Preexisting worktrees are not adopted by a scan; writing into one adopts and locks it.
  await guard.afterShell('git worktree add -b x other main', ctx);
  assert.deepEqual(guard.activeRoots(), []);
  assert.equal(guard.noteWriteTarget(path.join(task, 'a.md'), ctx), task);
  assert.deepEqual(guard.activeRoots(), [task]);
  assert.equal(lockState(linkedGitdir(task)).state, 'ours');
  assert.match(guard.workingStateSection(), /\.claude\/worktrees\/task on pi\/task: present, locked for this session/);
  assert.equal(guard.checkWrite(path.join(base, 'docs', 'b.md'), ctx), undefined);
  assert.deepEqual(guard.reviewNotices(base, ['docs/b.md', '.claude/worktrees/task/a.md']), [
    'Files go to the main checkout (' + path.basename(base) + ') on main (1 file).',
    'Files go to .claude/worktrees/task on pi/task (1 file).',
    '⚠ 1 file goes to the main checkout on main, not the task worktree.',
  ]);

  // Another agent force-removes it (as a merge-and-delete would).
  git(base, 'worktree', 'remove', '--force', '--force', task);
  const reason = guard.checkWrite(path.join(base, 'docs', 'b.md'), ctx);
  assert.match(reason, /was removed outside this session/);
  assert.ok(notes.some(([level, m]) => level === 'warning' && /removed outside this session/.test(m)));
  assert.match(guard.workingStateSection(), /REMOVED outside this session/);
  assert.ok(guard.reviewNotices(base, ['docs/b.md']).some(n => /was removed outside this session/.test(n)));
  assert.deepEqual(guard.activeRoots(), []);
  guard.acknowledgeRemoval();
  assert.equal(guard.checkWrite(path.join(base, 'docs', 'b.md'), ctx), undefined);
});

test('worktrees created by the session are adopted; /worktree done removal is not reported as lost; locks are released', async t => {
  const { base } = repoWithTaskWorktree(t);
  const guard = createWorktreeGuard({ launch: base, listWorktrees: async () => git(base, 'worktree', 'list', '--porcelain') });
  await guard.onSessionStart('sess-2');
  const mine = path.join(base, '.claude', 'worktrees', 'mine');
  git(base, 'worktree', 'add', '-q', '-b', 'pi/mine', mine, 'main');
  await guard.afterShell(`git worktree add -b pi/mine ${mine} main`);
  assert.deepEqual(guard.activeRoots(), [mine]);
  assert.equal(lockState(linkedGitdir(mine)).state, 'ours');
  guard.releaseAll();
  assert.equal(lockState(linkedGitdir(mine)).state, 'none');
  git(base, 'worktree', 'remove', mine);
  guard.forget(mine);
  assert.equal(guard.checkWrite(path.join(base, 'x.md')), undefined);
});

test('plan review flags edits to the project instructions and direct writes to main when AGENTS.md asks for worktrees', async t => {
  const { base } = repoWithTaskWorktree(t);
  const guard = createWorktreeGuard({ launch: base, listWorktrees: async () => '' });
  await guard.onSessionStart('sess-3');
  const notes = guard.reviewNotices(base, ['AGENTS.md', 'src/x.py']);
  assert.ok(notes.includes('⚠ 2 files go to main directly, but the project instructions describe a worktree per task.'));
  assert.ok(notes.includes('⚠ Edits the project instructions: AGENTS.md.'));
  assert.equal(guard.workingStateSection(), undefined);
});

test('worktree commands are recognised in shell commands and porcelain lists', () => {
  assert.ok(createsWorktree('git worktree add -b pi/x .claude/worktrees/x origin/main'));
  assert.ok(createsWorktree('cd repo && git -C . worktree add ../x'));
  assert.ok(!createsWorktree('git worktree list'));
  assert.ok(!createsWorktree('echo git worktree add'.replace('git', 'gitx')));
  assert.deepEqual(nestedWorktreesFromPorcelain('/r', 'worktree /r\nHEAD 1\n\nworktree /r/.claude/worktrees/a\n\nworktree /elsewhere\n'),
    ['/r/.claude/worktrees/a']);
});

test('rewind targets restore task worktrees from their first checkpoint at or after the turn', () => {
  const user = (id, text) => ({ type: 'message', id, message: { role: 'user', content: text } });
  const ckpt = (ref, kind = 'turn', extra = {}) => ({ type: 'custom', customType: checkpointEntryType, data: { entryId: null, ref, kind, ...extra } });
  const root = (r, ref) => ({ type: 'custom', customType: rootCheckpointEntryType, data: { entryId: null, root: r, ref } });
  const branch = [
    user('u1', 'first'), ckpt('refs/pi-protected-checkpoints/a'),
    user('u2', 'second'), ckpt('refs/pi-protected-checkpoints/b'), root('/r/wt', 'refs/pi-protected-checkpoints/w1'),
    user('u3', 'third'), ckpt('refs/pi-protected-checkpoints/c'), root('/r/wt', 'refs/pi-protected-checkpoints/w2'),
    ckpt('refs/pi-protected-checkpoints/s', 'safety', { roots: [{ root: '/r/wt', ref: 'refs/pi-protected-checkpoints/ws' }] }),
  ];
  const targets = buildRewindTargets(branch, 'refs/pi-protected-checkpoints/launch');
  const byTurn = n => targets.find(x => x.turnNumber === n);
  assert.deepEqual(byTurn(1).roots, [{ root: '/r/wt', ref: 'refs/pi-protected-checkpoints/w1' }]);
  assert.deepEqual(byTurn(3).roots, [{ root: '/r/wt', ref: 'refs/pi-protected-checkpoints/w2' }]);
  assert.match(byTurn(3).label, /\+ 1 task worktree/);
  assert.deepEqual(byTurn(0).roots, [{ root: '/r/wt', ref: 'refs/pi-protected-checkpoints/w1' }]);
  assert.deepEqual(targets[0].roots, [{ root: '/r/wt', ref: 'refs/pi-protected-checkpoints/ws' }]);
});

test('an approval prompt that times out is reported as unanswered, not as a refusal', async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const ctx = { cwd: '/r', hasUI: true, ui: { select: async () => { clock += APPROVAL_TIMEOUT_MS; return undefined; } } };
    assert.equal(await askApproval(ctx, 'Run shell command', 'ls'), false);
    assert.equal(lastApprovalMiss(), 'timeout');
    assert.match(shellNotApprovedMessage('timeout'), /got no answer within 60 s\. The user did not refuse it/);
    const deny = { ...ctx, ui: { select: async () => 'Deny' } };
    assert.equal(await askApproval(deny, 'Run shell command', 'ls'), false);
    assert.equal(lastApprovalMiss(), 'denied');
    assert.equal(shellNotApprovedMessage('denied'), 'Shell command not approved. Do not retry without user approval.');
  } finally {
    Date.now = realNow;
  }
});

test('exit words typed without the slash quit instead of reaching the model', () => {
  for (const s of ['.exit', 'exit', 'quit', '.quit', '\\exit', '.q', 'EXIT']) assert.ok(EXIT_TYPO.test(s), s);
  for (const s of ['q', 'exit the loop', 'please exit', '/exit']) assert.ok(!EXIT_TYPO.test(s), s);
});

test('images older than the last two prompts are replaced by a note naming the file', () => {
  const img = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const call = id => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'pi_safe_read', arguments: { path: `fig/${id}.png` } }] });
  const result = id => ({ role: 'toolResult', toolCallId: id, toolName: 'pi_safe_read', content: [{ type: 'text', text: 'Read image' }, img] });
  const msgs = [
    { role: 'user', content: 'p1' }, call('a'), result('a'),
    { role: 'user', content: 'p2' }, call('b'), result('b'),
    { role: 'user', content: 'p3' }, call('c'), result('c'),
  ];
  const out = stubOldImages(msgs);
  assert.ok(out);
  assert.equal(out[2].content.some(b => b.type === 'image'), false);
  assert.match(out[2].content.at(-1).text, /Image removed from older context: fig\/a\.png/);
  assert.ok(out[5].content.some(b => b.type === 'image'));
  assert.ok(out[8].content.some(b => b.type === 'image'));
  assert.ok(msgs[2].content.some(b => b.type === 'image'), 'input is not mutated');
  assert.equal(stubOldImages(msgs.slice(3)), undefined);
});

test('turn changes label files not written by the session tools', () => {
  const { rows } = formatTurnChanges({ total: 2, files: [
    { path: 'a.md', added: 3, removed: 0 },
    { path: 'docs/agent_records/other-agent.md', added: 96, removed: 0, unattributed: true },
  ] });
  assert.match(rows[0], /other-agent\.md .*\(shell or another process\)/);
  assert.match(rows.at(-1), /1 of these changed outside Pi's edit\/write tools/);
});

