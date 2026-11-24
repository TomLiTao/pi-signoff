import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { depsSandboxArgs, detectDepsPlan, findSecretFiles, parseDepsArgs } from './deps.ts';
import { draftPrompt, parseDraft, registerPr, suggestBranch } from './pr.ts';
import { buildHandoff } from './handoff.ts';
import { registerDataTool } from './data-tool.ts';

function tmp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-fn-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('/deps parses packages safely and picks the right manager', t => {
  assert.deepEqual(parseDepsArgs('add pandas>=2 polars --dev'), { action: 'add', pkgs: ['pandas>=2', 'polars'], flags: { dev: true, build: false, npm: false, python: false } });
  assert.throws(() => parseDepsArgs('add --index-url=http://evil x'), /Unknown option/);
  assert.throws(() => parseDepsArgs('add pandas;touch$(x)'), /does not look like/);
  assert.throws(() => parseDepsArgs('add pandas -rf'), /Unknown option/);
  const uvProject = tmp(t);
  writeFileSync(path.join(uvProject, 'pyproject.toml'), '[project]\nname="x"\n');
  writeFileSync(path.join(uvProject, 'uv.lock'), '');
  assert.deepEqual(detectDepsPlan(uvProject, 'add', ['pandas'], { dev: false, build: false, npm: false, python: false }).argv, ['uv', 'add', '--no-build', 'pandas']);
  assert.deepEqual(detectDepsPlan(uvProject, 'sync', [], { dev: false, build: true, npm: false, python: false }).argv, ['uv', 'sync']);
  const venvProject = tmp(t);
  writeFileSync(path.join(venvProject, 'pyproject.toml'), '[project]\nname="x"\n');
  assert.throws(() => detectDepsPlan(venvProject, 'add', ['x'], { dev: false, build: false, npm: false, python: false }), /run \/deps venv first/);
  mkdirSync(path.join(venvProject, '.venv/bin'), { recursive: true });
  writeFileSync(path.join(venvProject, '.venv/bin/python'), '');
  const venvPlan = detectDepsPlan(venvProject, 'add', ['duckdb'], { dev: false, build: false, npm: false, python: false });
  assert.deepEqual(venvPlan.argv, ['uv', 'pip', 'install', '--python', '.venv/bin/python', '--no-build', 'duckdb']);
  assert.match(venvPlan.notes.join(' '), /pyproject\.toml \/ requirements files are not changed/);
  assert.deepEqual(detectDepsPlan(venvProject, 'sync', [], { dev: false, build: false, npm: false, python: false }).argv.slice(-2), ['-r', 'pyproject.toml']);
  const node = tmp(t);
  writeFileSync(path.join(node, 'package.json'), '{}');
  assert.deepEqual(detectDepsPlan(node, 'add', ['zod'], { dev: true, build: false, npm: false, python: false }).argv, ['npm', 'install', '--save-dev', '--ignore-scripts', 'zod']);
});

test('/deps sandbox hides home, masks secrets, keeps .git read-only, and allows network', t => {
  const root = tmp(t);
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'cfg'));
  writeFileSync(path.join(root, '.env'), 'X=1');
  writeFileSync(path.join(root, 'cfg', 'secrets.yaml'), 'x');
  const secrets = findSecretFiles(root, ['.env', 'secrets.*']);
  assert.deepEqual(secrets.map(f => path.relative(root, f)).sort(), ['.env', 'cfg/secrets.yaml']);
  const args = depsSandboxArgs({ root, home: '/home/u', nodeHome: '/home/u/node', uvPath: '/home/u/.local/bin/uv', emptySecret: '/x/empty-secret', secretFiles: secrets });
  const joined = args.join(' ');
  assert.match(joined, /--tmpfs \/home\/u /);
  assert.match(joined, /--ro-bind-try \/home\/u\/\.local\/bin\/uv /);
  assert.match(joined, new RegExp(`--bind ${root} ${root}`));
  assert.match(joined, new RegExp(`--ro-bind ${root}/\\.git ${root}/\\.git`));
  assert.match(joined, new RegExp(`--ro-bind /x/empty-secret ${root}/\\.env`));
  assert.ok(args.includes('--share-net') && args.includes('--clearenv') && args.includes('--unshare-all'));
  assert.ok(args.indexOf('--tmpfs') < args.indexOf('--bind'), 'home is hidden before the project is bound');
});

test('/pr helpers and full flow with a fake git and gh', async t => {
  assert.equal(suggestBranch('Add Sharpe ratio to reports!'), 'pi/add-sharpe-ratio-to-reports');
  assert.deepEqual(parseDraft('\n# Add Sharpe ratio\n\n## Summary\n- x'), { title: 'Add Sharpe ratio', body: '## Summary\n- x' });
  assert.match(draftPrompt({ commits: '- a', stat: '1 file', patch: 'diff', runs: '#1 ok' }), /Recent script runs:\n#1 ok/);

  const root = tmp(t);
  const old = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(old));
  const calls = [];
  const replies = {
    'git rev-parse --show-toplevel': { code: 0, stdout: root },
    'gh auth status': { code: 0, stdout: '' },
    'git remote get-url origin': { code: 0, stdout: 'https://github.com/me/repo.git\n' },
    'gh repo view --json defaultBranchRef -q .defaultBranchRef.name': { code: 0, stdout: 'main\n' },
    'git branch --show-current': { code: 0, stdout: 'main\n' },
    'git log -1 --format=%s': { code: 0, stdout: 'Add Sharpe ratio\n' },
    'git check-ref-format --branch pi/add-sharpe-ratio': { code: 0, stdout: '' },
    'git switch -c pi/add-sharpe-ratio': { code: 0, stdout: '' },
    'git fetch --quiet origin main': { code: 0, stdout: '' },
    'git rev-parse --verify --quiet origin/main': { code: 0, stdout: 'abc' },
    'git log --no-decorate --format=- %s origin/main..HEAD': { code: 0, stdout: '- Add Sharpe ratio\n' },
    'git push -u origin pi/add-sharpe-ratio': { code: 0, stdout: '' },
  };
  const exec = async (cmd, args, _cwd, stdin) => {
    const key = `${path.basename(cmd)} ${args.join(' ')}`;
    calls.push({ key, stdin });
    if (key.startsWith('git status --porcelain')) return { code: 0, stdout: '', stderr: '' };
    if (key.startsWith('git diff --stat')) return { code: 0, stdout: ' a.py | 3 +++\n 1 file changed\n', stderr: '' };
    if (key.startsWith('git diff --no-ext-diff')) return { code: 0, stdout: '+x\n', stderr: '' };
    if (key.startsWith('gh pr create')) return { code: 0, stdout: 'https://github.com/me/repo/pull/7\n', stderr: '' };
    return { stderr: '', ...(replies[key] ?? { code: 1, stdout: '' }) };
  };
  const commands = new Map();
  const messages = [];
  const pi = { registerCommand(name, def) { commands.set(name, def.handler); }, sendMessage: m => messages.push(m) };
  registerPr(pi, {
    dir: root, exec, getSecretPatterns: () => ['.env'], isBusy: () => false,
    egressCheck: text => (text.includes('tok_SECRET') ? 'contains the value of TOKEN from .env' : null),
    draft: async prompt => { assert.match(prompt, /Add Sharpe ratio/); return 'Add Sharpe ratio to reports\n\n## Summary\n- adds it'; },
  });
  const notes = [];
  let editorText = null;
  const ctx = {
    cwd: root, hasUI: true, isIdle: () => true, model: { provider: 'p', id: 'm' },
    ui: {
      notify: m => notes.push(m),
      input: async (_title, suggested) => suggested.replace('-to-reports', ''),
      editor: async (_title, text) => { editorText = text; return text; },
      select: async (_title, choices) => choices[1],
    },
  };
  await commands.get('pr')('', ctx);
  assert.match(editorText, /^Add Sharpe ratio to reports/);
  const create = calls.find(c => c.key.startsWith('gh pr create'));
  assert.ok(create, notes.join('\n'));
  assert.match(create.key, /--base main --head pi\/add-sharpe-ratio --title Add Sharpe ratio to reports --body-file -/);
  assert.equal(create.stdin, '## Summary\n- adds it');
  assert.match(notes.at(-1), /Opened pull request: https:\/\/github\.com\/me\/repo\/pull\/7/);
  assert.match(messages.at(-1).content, /pull\/7/);

  // A secret in the edited description stops before anything is pushed.
  calls.length = 0;
  ctx.ui.editor = async () => 'Title\n\nuses tok_SECRET';
  await commands.get('pr')('', ctx);
  assert.equal(calls.some(c => c.key.startsWith('git push')), false);
  assert.match(notes.at(-1), /contains the value of TOKEN from \.env\. Edit it out/);
});

test('/handoff renders context, changes, runs, and a compact transcript', () => {
  const entries = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Add a Sharpe ratio' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'Reading the module.' }, { type: 'toolCall', id: 'c1', name: 'pi_safe_read', arguments: { path: '/w/quant/metrics.py' } }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'pi_safe_read', content: [{ type: 'text', text: 'a\nb\n' }], isError: false } },
    { type: 'custom', customType: 'pi-turn-changes', data: { total: 1, files: [{ added: 3, removed: 1 }] } },
  ];
  const md = buildHandoff(entries, {
    cwd: '/w', model: 'openai/gpt', mode: 'workflow', branch: 'pi/x', recap: 'Session recap', generatedAt: new Date('2026-11-24T10:00:00Z'),
    changes: { total: 1, files: [{ path: 'quant/metrics.py', added: 3, removed: 1, binary: false }] },
    runs: [{ id: 1, at: '2026-11-24T10:02:00.000Z', command: 'python3 run.py', script: 'python3 run.py', args: [], fingerprint: null, files: 0, status: 'ok', exitCode: 0, tail: '' }],
  });
  assert.match(md, /^# Pi session handoff — w — 2026-11-24 10:00 UTC/);
  assert.match(md, /- Git branch: `pi\/x`\n- Model: openai\/gpt\n- Permission mode: workflow/);
  assert.match(md, /## Changes since launch \(1 files, \+3 −1\)\n\n- `quant\/metrics\.py` \+3 −1/);
  assert.match(md, /## Script runs this session \(1\)\n\n- #1 /);
  assert.match(md, /### User\n\nAdd a Sharpe ratio\n\n### Assistant\n\nReading the module\.\n\n- `READ` quant\/metrics\.py → Read 2 lines\./);
  assert.match(md, /_Changed 1 file \(\+3 −1\)\._/);
  assert.doesNotMatch(md, /secret thoughts/);
});

test('data tool passes requests to the sandbox runner and surfaces errors', async () => {
  const tools = new Map();
  const requests = [];
  registerDataTool({ registerTool(def) { tools.set(def.name, def); } }, {
    runSandbox: async request => { requests.push(request); return request.action === 'query' ? JSON.stringify({ error: 'DuckDB error: x' }) : JSON.stringify({ text: 'ok' }); },
  });
  const tool = tools.get('pi_safe_data');
  assert.equal((await tool.execute('1', { action: 'preview', path: 'a.csv' }, undefined, undefined, { cwd: '/w' })).content[0].text, 'ok');
  await assert.rejects(tool.execute('2', { action: 'query', sql: 'select 1' }, undefined, undefined, { cwd: '/w' }), /DuckDB error: x/);
  await assert.rejects(tool.execute('3', { action: 'preview' }, undefined, undefined, { cwd: '/w' }), /Pass path/);
  assert.deepEqual(requests, [{ action: 'preview', path: 'a.csv', rows: 10 }, { action: 'query', sql: 'select 1', limit: 100 }]);
});
