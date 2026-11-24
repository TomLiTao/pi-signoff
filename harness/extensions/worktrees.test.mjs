import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerWorktreeCommands } from './worktrees.ts';

const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args],
  { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();

test('/worktree new creates pi/<task>; done refuses dirty trees and live runs, then merges and removes', async () => {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'pi-wt-')));
  try {
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-q', '-m', 'base');
    let live = [];
    let cmd;
    const git = (args, cwd) => {
      try {
        return Promise.resolve({ code: 0, stdout: g(cwd, ...args), stderr: '' });
      } catch (error) {
        return Promise.resolve({ code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') });
      }
    };
    registerWorktreeCommands({ registerCommand: (_n, c) => { cmd = c; } }, { git, liveRunsUnder: () => live });
    const notes = [];
    const ctx = {
      cwd: repo, hasUI: true,
      ui: { notify: (m, level) => notes.push([level, m]), select: async (_p, choices) => choices.find(c => c !== 'Cancel') },
    };
    await cmd.handler('new demo', ctx);
    const wt = path.join(repo, '.claude/worktrees/demo');
    assert.ok(existsSync(wt), JSON.stringify(notes));
    assert.equal(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pi/demo');

    await cmd.handler('new demo', ctx);
    assert.match(notes.at(-1)[1], /already exists/);

    writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    await cmd.handler('done demo', ctx);
    assert.match(notes.at(-1)[1], /uncommitted or untracked/);
    g(wt, 'add', 'b.txt');
    g(wt, 'commit', '-q', '-m', 'work');

    live = ['r20261124T000000-abcdef'];
    await cmd.handler('done demo', ctx);
    assert.match(notes.at(-1)[1], /still using this worktree/);
    live = [];

    await cmd.handler('done demo', { ...ctx, cwd: wt });
    assert.match(notes.at(-1)[1], /main checkout/);

    await cmd.handler('done demo', ctx);
    assert.match(notes.at(-1)[1], /Merged pi\/demo into main/);
    assert.ok(!existsSync(wt));
    assert.ok(existsSync(path.join(repo, 'b.txt')));
    assert.equal(g(repo, 'branch', '--list', 'pi/demo'), '');

    await cmd.handler('new Bad/Name', ctx);
    assert.match(notes.at(-1)[1], /Usage/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
