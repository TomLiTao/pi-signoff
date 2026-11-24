import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { countBySeverity, formatDiagnostics, locateColumn, registerCodeIntel } from './code-intel.ts';

const NODE_HOME = `${process.env.HOME}/.local/share/ubuntu-workstation/node/node-v24.22.2-linux-x64`;
const SERVER = `${NODE_HOME}/lib/node_modules/basedpyright/langserver.index.js`;
const policy = { secretPaths: ['.env'], deniedPaths: ['.git', '.git/**'], askPaths: [] };

test('helpers locate symbols and format diagnostics', () => {
  assert.equal(locateColumn('    total = price_total(x)', 'price_total'), 12);
  assert.equal(locateColumn('a = ab + a', 'a'), 0);
  assert.equal(locateColumn('x = 1', 'missing'), null);
  assert.equal(locateColumn('x = 1', undefined, 3), 2);
  const d = [{ range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } }, severity: 1, message: 'Bad\n thing', rule: 'reportX' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 2, message: 'meh' }];
  assert.deepEqual(formatDiagnostics('a.py', d), ['a.py:5:3 error: Bad thing [reportX]', 'a.py:2:1 warning: meh']);
  assert.deepEqual(countBySeverity(d), { errors: 1, warnings: 1 });
});

test('real basedpyright: diagnostics, definition, references, hover, symbols, rename preview, edit notes', { timeout: 120_000 }, async t => {
  if (!existsSync(SERVER)) { t.skip('basedpyright is not installed'); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'quant'));
  writeFileSync(path.join(root, 'quant', '__init__.py'), '');
  writeFileSync(path.join(root, 'quant', 'metrics.py'), 'def sharpe(returns: list[float]) -> float:\n    return sum(returns) / len(returns)\n');
  writeFileSync(path.join(root, 'run.py'), 'from quant.metrics import sharpe\n\nvalue: int = sharpe([0.1, 0.2])\nprint(sharpe([1.0]))\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  const tools = new Map();
  const handlers = new Map();
  const pi = { registerTool(def) { tools.set(def.name, def); }, on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); } };
  const handle = registerCodeIntel(pi, {
    spawnServer: async () => spawn(`${NODE_HOME}/bin/node`, [SERVER, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] }),
    getPolicy: () => policy,
  });
  t.after(() => handle.stop());
  const code = args => tools.get('pi_safe_code').execute('id', args, undefined, undefined, { cwd: root }).then(r => r.content[0].text);

  const diag = await code({ action: 'diagnostics', paths: ['run.py', 'quant/metrics.py'] });
  assert.match(diag, /^basedpyright: 1 error/);
  assert.match(diag, /run\.py:3:\d+ error: Type "float" is not assignable to declared type "int"/);
  assert.match(diag, /quant\/metrics\.py: no problems/);

  assert.match(await code({ action: 'definition', path: 'run.py', line: 4, symbol: 'sharpe' }), /quant\/metrics\.py:1:5  def sharpe/);
  const refs = await code({ action: 'references', path: 'quant/metrics.py', line: 1, symbol: 'sharpe' });
  assert.match(refs, /^4 references to sharpe/);
  assert.match(await code({ action: 'hover', path: 'run.py', line: 4, symbol: 'sharpe' }), /def sharpe\(returns: list\[float\]\) -> float/);
  assert.match(await code({ action: 'symbols', path: 'quant/metrics.py' }), /function sharpe .*\(L1-2\)/);
  const rename = await code({ action: 'rename', path: 'quant/metrics.py', line: 1, symbol: 'sharpe', newName: 'sharpe_ratio' });
  assert.match(rename, /Rename preview: sharpe → sharpe_ratio \(\d+ edits in 2 files\)/);
  assert.match(rename, /L1: from quant\.metrics import sharpe  →  from quant\.metrics import sharpe_ratio/);
  await assert.rejects(code({ action: 'symbols', path: '.env' }), /protected|Python files/);

  // Edit notes: fixing the error is reflected in the appended note.
  writeFileSync(path.join(root, 'run.py'), 'from quant.metrics import sharpe\n\nvalue: float = sharpe([0.1, 0.2])\n');
  const [onResult] = handlers.get('tool_result');
  const res = await onResult({ toolName: 'pi_safe_edit', input: { path: 'run.py' }, isError: false, content: [{ type: 'text', text: 'ok' }] }, { cwd: root });
  assert.equal(res.content.at(-1).text.trim(), 'basedpyright: no errors in run.py.');
  writeFileSync(path.join(root, 'run.py'), 'from quant.metrics import sharpe\n\nvalue: str = sharpe([0.1])\nundefined_name\n');
  const bad = await onResult({ toolName: 'pi_safe_write', input: { path: 'run.py' }, isError: false, content: [{ type: 'text', text: 'ok' }] }, { cwd: root });
  assert.match(bad.content.at(-1).text, /basedpyright: 2 errors in run\.py[\s\S]*run\.py:4:1 error: "undefined_name" is not defined/);
  assert.equal(await onResult({ toolName: 'pi_safe_edit', input: { path: 'notes.md' }, isError: false, content: [] }, { cwd: root }), undefined);
});
