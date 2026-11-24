import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEgressGuard, parseDotenvSecrets } from './egress-guard.ts';
import { withImagesForModel } from './read-images.ts';
import { bashOutcome, formatRunLine, leadingCommand, outputTail, runLogStore } from './run-log.ts';
import { checkScriptGrants, makeScriptGrant, neverAutoMatch, parseScriptCommand, resolveWorkspaceModule } from './script-grants.ts';

const policy = { secretPaths: ['.env', '.env.*'], deniedPaths: ['.git', '.git/**'], askPaths: [] };

function tmp(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('never-auto patterns catch broker/deploy scripts in any command form, not plain words', () => {
  const globs = ['*broker*', 'ibkr*', 'deploy*', 'scripts/live/*'];
  assert.deepEqual(neverAutoMatch('python3 scripts/c01s_broker.py --dry-run', globs), { target: 'scripts/c01s_broker.py', pattern: '*broker*' });
  assert.equal(neverAutoMatch('python3 -m scripts.ibkr_paper_fx', globs)?.pattern, 'ibkr*');
  assert.equal(neverAutoMatch('python3 -mscripts.deploy_osaka', globs)?.pattern, 'deploy*');
  assert.equal(neverAutoMatch('bash -c "python3 ./scripts/IBKR_market_probe.py | tee log"', globs)?.pattern, 'ibkr*');
  assert.equal(neverAutoMatch('nohup .venv/bin/python scripts/live/run.py &', globs)?.pattern, 'scripts/live/*');
  assert.equal(neverAutoMatch('rg broker scripts', globs), null, 'plain words are not scripts');
  assert.equal(neverAutoMatch('python3 scripts/backtest.py', globs), null);
  assert.equal(neverAutoMatch('python3 scripts/c01s_broker.py', []), null);
});

test('python -m runs resolve to workspace modules and pin package __init__ files', t => {
  const cwd = tmp(t, 'pi-mod-');
  mkdirSync(path.join(cwd, 'scripts', 'studies'), { recursive: true });
  writeFileSync(path.join(cwd, 'scripts', '__init__.py'), '');
  writeFileSync(path.join(cwd, 'scripts', 'daily_memo.py'), 'from scripts import util\n');
  writeFileSync(path.join(cwd, 'scripts', 'util.py'), 'X = 1\n');
  mkdirSync(path.join(cwd, 'scripts', 'studies', 'pkg'));
  writeFileSync(path.join(cwd, 'scripts', 'studies', 'pkg', '__main__.py'), 'print(1)\n');
  assert.equal(resolveWorkspaceModule(cwd, 'scripts.daily_memo'), 'scripts/daily_memo.py');
  assert.equal(resolveWorkspaceModule(cwd, 'scripts.studies.pkg'), 'scripts/studies/pkg/__main__.py');
  assert.equal(resolveWorkspaceModule(cwd, 'pytest'), null);
  const parsed = parseScriptCommand('python3 -m scripts.daily_memo --date 2026-11-24', cwd, policy);
  assert.deepEqual(parsed, { interpreter: 'python3', script: '-m scripts.daily_memo', file: 'scripts/daily_memo.py', module: 'scripts.daily_memo', args: ['--date', '2026-11-24'] });
  assert.equal(parseScriptCommand('python3 -m pytest -q', cwd, policy), null, 'non-workspace modules stay with autonomy/prefix rules');
  const grant = makeScriptGrant('python3 -m scripts.daily_memo', cwd, policy);
  assert.deepEqual(grant.files, ['scripts/daily_memo.py', 'scripts/__init__.py', 'scripts/util.py']);
  assert.equal(checkScriptGrants('python3 -m scripts.daily_memo --date 2026-11-25', cwd, [grant], policy), 'match');
  assert.equal(checkScriptGrants('python3 scripts/daily_memo.py', cwd, [grant], policy), 'none', 'path and module runs are separate grants');
  writeFileSync(path.join(cwd, 'scripts', '__init__.py'), 'import os\n');
  assert.equal(checkScriptGrants('python3 -m scripts.daily_memo', cwd, [grant], policy), 'changed', 'editing the package __init__ voids it');
});

test('egress guard blocks dotenv values and credential-shaped strings without echoing them', t => {
  const cwd = tmp(t, 'pi-egress-');
  writeFileSync(path.join(cwd, '.env'), [
    'IBKR_ACCOUNT=U7654321',
    'export BROKER_TOKEN="tok_9f8e7d6c5b4a"',
    'DEBUG=true',
    'PORT=7497',
    'HOST=127.0.0.1',
    'DATA_DIR=/srv/data',
    'MODE=paperonly',
  ].join('\n'));
  writeFileSync(path.join(cwd, '.env.local'), 'EXTRA_SECRET=abcDEF123456\n');
  assert.deepEqual(parseDotenvSecrets('A=short\nB=true\nC=Zx9!long-enough\n# D=commented'), [{ key: 'C', value: 'Zx9!long-enough' }]);
  const guard = createEgressGuard(cwd);
  assert.equal(guard.check('python pandas rolling window'), null);
  assert.equal(guard.check('ibkr account U7654321 margin'), 'contains the value of IBKR_ACCOUNT from .env');
  assert.equal(guard.check('https://api.example.com/q?x=tok_9f8e7d6c5b4a'), 'contains the value of BROKER_TOKEN from .env');
  assert.equal(guard.check('https://x.test/?q=abcDEF%31%32%33456'), 'contains the value of EXTRA_SECRET from .env.local', 'URL-encoded values are decoded');
  assert.equal(guard.check('error sk-proj-abcdefghijklmnopqrstuvwx'), 'contains what looks like an OpenAI-style API key');
  assert.equal(guard.check('AKIAABCDEFGHIJKLMNOP leaked'), 'contains what looks like an AWS access key ID');
  assert.equal(guard.check('https://h.test/data?api_key=0123456789abcdef'), 'contains what looks like a credential in a URL');
  assert.equal(guard.check('https://user:hunter22@h.test/'), 'contains what looks like a password in a URL');
  assert.equal(guard.check('localhost 7497 127.0.0.1 /srv/data paperonly'), null, 'generic values are not treated as secrets');
  assert.equal(guard.redact('acct U7654321 key sk-ant-abcdefghijklmnopqrstuv end'), 'acct [redacted] key [redacted] end');
});

test('images are replaced by a note only for models without image input', () => {
  const result = { content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }], structuredContent: { type: 'image' } };
  assert.equal(withImagesForModel(result, { model: { id: 'gpt', input: ['text', 'image'] } }), result);
  assert.equal(withImagesForModel(result, {}), result, 'unknown model: keep the image');
  const stripped = withImagesForModel(result, { model: { id: 'flint-local', input: ['text'] } });
  assert.equal(stripped.content.some(b => b.type === 'image'), false);
  assert.match(stripped.content.at(-1).text, /^\[Image not shown: flint-local does not accept images/);
});

test('run log helpers parse outcomes and keep a private, redacted, append-only log', t => {
  assert.deepEqual(bashOutcome('boom\n\nCommand exited with code 3', true), { status: 'failed', exitCode: 3 });
  assert.deepEqual(bashOutcome('done', false), { status: 'ok', exitCode: 0 });
  assert.deepEqual(bashOutcome('Command timed out after 120 seconds', true), { status: 'timed out' });
  assert.equal(bashOutcome('Shell command not approved. Do not retry.', true), null, 'denied commands never ran');
  assert.equal(leadingCommand('python3 x.py --a 1 > out.txt 2>&1'), 'python3 x.py --a 1');
  assert.equal(leadingCommand('python3 x.py | tee log'), 'python3 x.py');
  assert.equal(outputTail(`${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\x1b[31m`).split('\n').length, 20);

  const cwd = tmp(t, 'pi-runs-ws-');
  const state = tmp(t, 'pi-runs-state-');
  assert.throws(() => runLogStore(cwd, path.join(cwd, 'runs')), /outside the workspace/);
  const log = runLogStore(cwd, path.join(state, 'runs'));
  const base = { at: '2026-11-24T10:02:00.000Z', command: 'python3 scripts/backtest.py --year 2021', script: 'python3 scripts/backtest.py', args: ['--year', '2021'], fingerprint: 'a'.repeat(64), files: 3, status: 'ok', exitCode: 0, durationMs: 12_345, tail: 'Sharpe 1.2', checkpoint: 'refs/pi-protected-checkpoints/20261124-100000-d1000dca' };
  const first = log.append(base);
  const second = log.append({ ...base, fingerprint: 'b'.repeat(64), codeChanged: true, status: 'failed', exitCode: 1 });
  assert.deepEqual([first.id, second.id], [1, 2]);
  assert.equal((statSync(log.file).mode & 0o777), 0o600);
  assert.equal(log.lastFor('python3 scripts/backtest.py').id, 2);
  assert.equal(formatRunLine(log.get(1)), '#1  11-24 10:02  python3 scripts/backtest.py --year 2021  — exit 0 · 12.3s · code aaaaaaaa (3 files) · ckpt d1000dca');
  assert.match(formatRunLine(log.get(2)), /exit 1 .*code bbbbbbbb \(3 files\) changed/);
  assert.equal(runLogStore(cwd, path.join(state, 'runs')).append(base).id, 3, 'ids continue across sessions');
  assert.equal(log.clear(), 3);
  assert.deepEqual(log.list(), []);
});

test('web search and fetch refuse to send text the egress guard flags, before any helper runs', async t => {
  // web-search.ts imports typebox at runtime; resolve it from pi's own install when available.
  const piModules = `${process.env.HOME}/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules`;
  const { existsSync } = await import('node:fs');
  if (!existsSync(`${piModules}/typebox`)) { t.skip('pi-coding-agent is not installed here'); return; }
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const hook = `export async function resolve(spec, ctx, next) { return spec === 'typebox' || spec.startsWith('typebox/') ? next(spec, { ...ctx, parentURL: ${JSON.stringify(pathToFileURL(`${piModules}/x.mjs`).href)} }) : next(spec, ctx); }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
  const { registerWebSearch, registerWebFetch } = await import('./web-search.ts');
  const tools = new Map();
  const pi = { registerTool(def) { tools.set(def.name, def); } };
  let ran = 0;
  const runRead = async fn => { ran++; return fn(); };
  const guard = text => (text.includes('tok_SECRET') ? 'contains the value of TOKEN from .env' : null);
  registerWebSearch(pi, '/nonexistent', false, false, runRead, guard);
  registerWebFetch(pi, '/nonexistent', runRead, guard);
  await assert.rejects(tools.get('pi_safe_web_search').execute('1', { query: 'what is tok_SECRET' }),
    /Blocked before sending: the search query contains the value of TOKEN from \.env\. Nothing was sent/);
  await assert.rejects(tools.get('pi_safe_web_fetch').execute('2', { url: 'https://x.test/?t=tok_SECRET' }),
    /Blocked before sending: the URL contains/);
  assert.equal(ran, 0, 'the network helper never started');
});
