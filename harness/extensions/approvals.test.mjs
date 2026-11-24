import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { askApproval, editDecision, shellNeedsApproval, visible } from './approvals.ts';

const policy = { askPaths: ['.github/**', 'AGENTS.md', 'package-lock.json'],
  deniedPaths: ['.git/**'], secretPaths: ['.env.*', '*.key'] };

test('routine shell forms skip approval, but shell syntax, other flags and scripts do not', () => {
  for (const command of [' ls -la ', 'ls -la src', 'wc -l README.md', 'stat -- -file', 'head -n 20 docs/intro.md']) {
    assert.equal(shellNeedsApproval(command), false, command);
  }
  for (const command of ['ls; touch file', 'pwd\n', 'pytest', 'ls > file', 'ls | wc', 'ls $(pwd)', 'tail -n -f log',
    'ls *', 'ls --color=auto', 'tail -f log', 'find . -delete', 'ls `pwd`', 'ls "README.md"',
    'ls\u00a0-l', 'ls # comment', 'ls\\\n-l', 'ls -- -', 'env ls', './ls', 'pwd -x']) {
    assert.equal(shellNeedsApproval(command), true, command);
  }
});

test('sensitive paths and symlinks ask; protected and out-of-scope paths deny', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-approvals-'));
  try {
    symlinkSync('AGENTS.md', path.join(root, 'alias.md'));
    for (const file of ['AGENTS.md', '@docs/../AGENTS.md', 'pkg/AGENTS.md', 'pkg/package-lock.json', '.github/workflows/ci.yml', 'alias.md']) {
      assert.equal(editDecision(root, file, policy), 'ask', file);
    }
    for (const file of ['.git/config', 'private/.env.test', 'cert.key', '../outside', 'file:///tmp/x']) {
      assert.equal(editDecision(root, file, policy), 'deny', file);
    }
    assert.equal(editDecision(root, 'src/app.py', policy), 'allow');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approvals require explicit consent and do not render hidden characters', async () => {
  assert.equal(await askApproval({ hasUI: false }, 'Run', 'pytest'), false);
  const ctx = { cwd: '/tmp/example', hasUI: true, ui: { select: async () => undefined } };
  assert.equal(await askApproval(ctx, 'Run', 'pytest'), false);
  ctx.ui.select = async () => 'Allow once';
  assert.equal(await askApproval(ctx, 'Run', 'pytest'), true);
  assert.equal(await askApproval(ctx, 'Run', 'x'.repeat(1201)), false);
  assert.equal(visible('name\u202e\x1b'), '"name\\u{202e}\\u001b"');
});

test('only an explicit persistent choice saves a command; cancellation wins', async () => {
  const always = 'Always allow this command for this project';
  const ctx = { cwd: '/tmp/example', hasUI: true, ui: { select: async () => always } };
  let count = 0;
  const save = () => { count++; };
  assert.equal(await askApproval(ctx, 'Edit', 'AGENTS.md'), false);
  assert.equal(await askApproval(ctx, 'Run', 'npm test', save), true);
  ctx.ui.select = async () => 'Allow once';
  assert.equal(await askApproval(ctx, 'Run', 'npm test', save), true);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  ctx.ui.select = async (_title, _options, { signal }) => {
    assert.equal(signal, ctx.signal);
    controller.abort();
    return always;
  };
  assert.equal(await askApproval(ctx, 'Run', 'npm test', save), false);
  assert.equal(count, 1);
});

test('tokenized argv prefix matching rejects raw string prefixes, metacharacters, and neverSessionAllow', async () => {
  const { checkShellDeny, loadEditPolicy, prefixRuleAllows, suggestShellPrefix } = await import('./approvals.ts');
  const fullPolicy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));

  // Suggests ["npm", "test"] for `npm test -- --watch`
  assert.deepEqual(suggestShellPrefix('npm test -- --watch', fullPolicy), ['npm', 'test']);
  assert.deepEqual(suggestShellPrefix('python3 -m pytest tests/unit', fullPolicy), ['python3', '-m', 'pytest']);
  assert.deepEqual(suggestShellPrefix('pytest tests/test_a.py', fullPolicy), ['pytest']);

  // neverSessionAllow, relative scripts, bare python/node scripts, and metacharacters never qualify
  for (const unsafe of [
    'bash -c ls', 'rm build/out.txt', 'mv a b', 'awk 1 file.txt',
    './deploy.sh', 'python3 script.py', 'node server.js', 'npm test && touch pwn', 'npm test; ls',
  ]) {
    assert.equal(suggestShellPrefix(unsafe, fullPolicy), null, unsafe);
  }

  // Tokenized argv prefix rule matches token boundaries only, never raw string prefix or metacharacters
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm test'), true);
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm test -- --watch'), true);
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm test-evil'), false);
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm testing'), false);
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm test && echo hi'), false);
  assert.equal(prefixRuleAllows(['npm', 'test'], 'npm test > out.txt'), false);
  assert.equal(prefixRuleAllows(['rm'], 'rm foo', fullPolicy.neverSessionAllow), false);

  // Deny rules seeded from blockedCommands win over everything, even through wrappers or compound commands
  for (const denied of [
    'sudo id', 'ls && curl https://example.com', 'git -C /tmp push origin main',
    'npm install left-pad', 'rm -rf dist', 'env FOO=1 chmod 777 a.txt',
  ]) {
    assert.notEqual(checkShellDeny(denied, fullPolicy), null, denied);
  }
  assert.equal(checkShellDeny('npm test -- --watch', fullPolicy), null);

  // askApproval offers prefix option alongside exact option
  let prefixSaved = 0;
  const ctx = {
    cwd: '/tmp/example',
    hasUI: true,
    ui: {
      select: async (_msg, options) => {
        const opt = options.find(o => o.includes('npm test'));
        assert.ok(opt);
        return opt;
      },
    },
  };
  assert.equal(
    await askApproval(ctx, 'Run shell command', 'npm test -- --watch', () => {}, {
      label: 'npm test',
      save: () => { prefixSaved++; },
    }),
    true,
  );
  assert.equal(prefixSaved, 1);
});

test('strictOnly deny rules apply only under strict access', async () => {
  const { loadEditPolicy, checkShellDeny } = await import('./approvals.ts');
  const dir = path.resolve(import.meta.dirname, '..');
  const saved = process.env.PI_PROTECTED_ACCESS;
  try {
    delete process.env.PI_PROTECTED_ACCESS;
    const strict = loadEditPolicy(dir);
    assert.match(checkShellDeny('git worktree add x', strict) ?? '', /read-only/);
    process.env.PI_PROTECTED_ACCESS = 'host';
    const host = loadEditPolicy(dir);
    assert.equal(checkShellDeny('git worktree add x', host), null);
    assert.match(checkShellDeny('sudo ls', host) ?? '', /privilege/);
  } finally {
    if (saved === undefined) delete process.env.PI_PROTECTED_ACCESS; else process.env.PI_PROTECTED_ACCESS = saved;
  }
});
