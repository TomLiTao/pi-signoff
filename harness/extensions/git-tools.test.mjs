import assert from 'node:assert/strict';
import test from 'node:test';
import { gitToolName, registerGitTools } from './git-tools.ts';

const policy = {
  askPaths: ['AGENTS.md'],
  deniedPaths: ['.git/**'],
  secretPaths: ['.env', '.env.*', '*.key'],
};

test('/commit shows diff --stat, drafts message without tools, lets user edit, and blocks staged secrets', async () => {
  const cwd = process.cwd();
  const commands = new Map();
  const toolsList = [];
  const gitCalls = [];
  let stagedNames = 'src/app.ts\0';

  registerGitTools(
    {
      registerTool: t => toolsList.push(t.name),
      registerCommand: (name, cmd) => commands.set(name, cmd.handler),
    },
    {
      dir: cwd,
      nodeHome: process.execPath,
      gitToolEnabled: true,
      registerCommitCommand: true,
      getPolicy: () => policy,
      runRead: fn => fn(),
      draftCommitMessage: async stat => {
        assert.match(stat, /src\/app\.ts/);
        return 'feat: drafted subject';
      },
      execHostGit: async (args, _cwd, stdin) => {
        gitCalls.push({ args, stdin });
        if (args.includes('--stat')) return { code: 0, stdout: ' src/app.ts | 2 +-\n 1 file changed\n', stderr: '' };
        if (args.includes('--name-only')) return { code: 0, stdout: stagedNames, stderr: '' };
        if (args.includes('commit')) return { code: 0, stdout: '[main abc1234] feat: user edited subject\n', stderr: '' };
        return { code: 0, stdout: 'diff --git a/src/app.ts b/src/app.ts\n+ok\n', stderr: '' };
      },
    },
  );

  assert.deepEqual(toolsList, [gitToolName]);
  assert.ok(commands.has('commit'));

  const notices = [];
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: msg => notices.push(msg),
      select: async () => 'Cancel',
      editor: async (_title, prefill) => {
        assert.equal(prefill, 'feat: drafted subject');
        return 'feat: user edited subject';
      },
    },
  };

  await commands.get('commit')('', ctx);
  assert.match(notices[0], /Staged changes:\nsrc\/app\.ts/);
  assert.match(notices.at(-1), /Committed:/);
  const commitCall = gitCalls.find(c => c.args.includes('commit'));
  assert.equal(commitCall.stdin, 'feat: user edited subject\n');

  // If a secret file (.env) is staged in the index, /commit refuses to commit!
  stagedNames = 'src/app.ts\0.env\0';
  gitCalls.length = 0;
  await commands.get('commit')('', ctx);
  assert.match(notices.at(-1), /Refusing to commit.*"\.env"/);
  assert.equal(gitCalls.some(c => c.args.includes('commit')), false);
});

test('pi_safe_git_remote builds fast-forward pulls and refuses forced or option-shaped arguments', async () => {
  const { buildRemoteGitArgs } = await import('./git-tools.ts');
  assert.deepEqual(buildRemoteGitArgs({ action: 'pull' }), ['pull', '--ff-only', 'origin']);
  assert.deepEqual(buildRemoteGitArgs({ action: 'push', flags: ['-u'], refspecs: ['claude/task'] }), ['push', '-u', 'origin', 'claude/task']);
  assert.deepEqual(buildRemoteGitArgs({ action: 'fetch', flags: ['--all', '--prune'] }), ['fetch', '--all', '--prune']);
  for (const bad of [
    { action: 'push', flags: ['--force'] },
    { action: 'push', refspecs: ['+main'] },
    { action: 'push', refspecs: ['--upload-pack=evil'] },
    { action: 'fetch', remote: 'https://example.com/x.git' },
    { action: 'clone' },
    { action: 'fetch', flags: ['--all'], refspecs: ['main'] },
  ]) assert.throws(() => buildRemoteGitArgs(bad), undefined, JSON.stringify(bad));
});
