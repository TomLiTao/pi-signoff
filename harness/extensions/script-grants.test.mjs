import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkScriptGrants, makeScriptGrant, parseScriptCommand, scanPythonImports, scriptFingerprint,
} from './script-grants.ts';
import { projectDefaultsStore, describeDefaults, sanitizeDefaults } from './project-defaults.ts';

const policy = { secretPaths: ['.env', '*.pem'], deniedPaths: ['.git', '.git/**'], askPaths: ['AGENTS.md'] };

function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-script-grants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, 'quant'));
  writeFileSync(path.join(dir, 'quant', '__init__.py'), '');
  writeFileSync(path.join(dir, 'quant', 'signals.py'), 'from .util import clip\ndef sig(x):\n    return clip(x)\n');
  writeFileSync(path.join(dir, 'quant', 'util.py'), 'def clip(x):\n    return x\n');
  writeFileSync(path.join(dir, 'scripts', 'backtest.py'), 'import sys, json\nfrom quant.signals import sig\nimport helpers\nprint(sig(1))\n');
  writeFileSync(path.join(dir, 'scripts', 'helpers.py'), 'X = 1\n');
  return dir;
}

test('script commands parse only plain workspace Python runs', t => {
  const cwd = workspace(t);
  assert.deepEqual(parseScriptCommand('python3 scripts/backtest.py --start 2020-01-01 --tickers AAPL,MSFT', cwd, policy),
    { interpreter: 'python3', script: 'scripts/backtest.py', file: 'scripts/backtest.py', args: ['--start', '2020-01-01', '--tickers', 'AAPL,MSFT'] });
  assert.equal(parseScriptCommand('python3 -u scripts/backtest.py', cwd, policy)?.script, 'scripts/backtest.py');
  assert.equal(parseScriptCommand('.venv/bin/python scripts/backtest.py', cwd, policy)?.interpreter, '.venv/bin/python');
  assert.equal(parseScriptCommand('python3 -c print(1)', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 -m pytest', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 scripts/backtest.py | tee out.txt', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 scripts/backtest.py > out.txt', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 "scripts/backtest.py"', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 ../outside.py', cwd, policy), null);
  assert.equal(parseScriptCommand('PYTHONPATH=x python3 scripts/backtest.py', cwd, policy), null);
  assert.equal(parseScriptCommand('bash scripts/run.sh', cwd, policy), null);
  assert.equal(parseScriptCommand('python3 .git/hooks/x.py', cwd, policy), null);
  symlinkSync(path.join(cwd, 'scripts', 'backtest.py'), path.join(cwd, 'link.py'));
  assert.equal(parseScriptCommand('python3 link.py', cwd, policy), null);
});

test('import scan finds absolute, relative, parenthesized and dynamic imports', () => {
  const refs = scanPythonImports([
    'import os, numpy as np',
    'from . import util',
    'from ..core.engine import (Engine,',
    '    run as go)',
    '    import helpers  # indented, inside a function',
    'mod = importlib.import_module("plugins.alpha")',
  ].join('\n'));
  const keys = refs.map(r => `${r.level}:${r.module}:${r.names.join('|')}`);
  assert.ok(keys.includes('0:os:'));
  assert.ok(keys.includes('0:numpy:'));
  assert.ok(keys.includes('1::util'));
  assert.ok(keys.includes('2:core.engine:Engine|run'));
  assert.ok(keys.includes('0:helpers:'));
  assert.ok(keys.includes('0:plugins.alpha:'));
});

test('fingerprint covers the script and its local imports, and changes when any of them change', t => {
  const cwd = workspace(t);
  const fp = scriptFingerprint(cwd, 'scripts/backtest.py', policy);
  assert.ok(fp);
  assert.equal(fp.files[0], 'scripts/backtest.py');
  for (const f of ['scripts/helpers.py', 'quant/__init__.py', 'quant/signals.py', 'quant/util.py']) {
    assert.ok(fp.files.includes(f), `expected ${f} in ${fp.files}`);
  }
  const grant = makeScriptGrant('python3 scripts/backtest.py', cwd, policy);
  assert.equal(checkScriptGrants('python3 scripts/backtest.py --year 2021', cwd, [grant], policy), 'match');
  assert.equal(checkScriptGrants('python scripts/backtest.py', cwd, [grant], policy), 'none', 'interpreter is part of the grant');
  assert.equal(checkScriptGrants('python3 scripts/helpers.py', cwd, [grant], policy), 'none');

  // Editing a transitively imported module voids the grant.
  writeFileSync(path.join(cwd, 'quant', 'util.py'), 'import os\ndef clip(x):\n    os.system("x")\n');
  assert.equal(checkScriptGrants('python3 scripts/backtest.py', cwd, [grant], policy), 'changed');
  writeFileSync(path.join(cwd, 'quant', 'util.py'), 'def clip(x):\n    return x\n');
  assert.equal(checkScriptGrants('python3 scripts/backtest.py', cwd, [grant], policy), 'match');

  // A new file that shadows a stdlib import next to the script also voids it.
  writeFileSync(path.join(cwd, 'scripts', 'json.py'), 'print("shadow")\n');
  assert.equal(checkScriptGrants('python3 scripts/backtest.py', cwd, [grant], policy), 'changed');
  rmSync(path.join(cwd, 'scripts', 'json.py'));

  // Editing the script itself voids it.
  writeFileSync(path.join(cwd, 'scripts', 'backtest.py'), 'print("changed")\n');
  assert.equal(checkScriptGrants('python3 scripts/backtest.py', cwd, [grant], policy), 'changed');
});

test('missing scripts cannot be pinned', t => {
  const cwd = workspace(t);
  assert.equal(makeScriptGrant('python3 scripts/missing.py', cwd, policy), null);
  assert.equal(scriptFingerprint(cwd, 'scripts/missing.py', policy), null);
});

test('project defaults live outside the workspace, are private, and validate their values', t => {
  const cwd = workspace(t);
  const state = mkdtempSync(path.join(os.tmpdir(), 'pi-defaults-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  assert.throws(() => projectDefaultsStore(cwd, path.join(cwd, 'state')), /outside the workspace/);
  const store = projectDefaultsStore(cwd, path.join(state, 'project-defaults'));
  assert.deepEqual(store.read(), {});
  store.update({ mode: 'workflow' });
  store.update({ autonomy: 'medium' });
  assert.deepEqual(store.read(), { mode: 'workflow', autonomy: 'medium' });
  assert.equal(describeDefaults(store.read()), 'workflow, Auto (Medium)');
  store.update({ spec: true });
  assert.equal(describeDefaults(store.read()), 'Spec → workflow, Auto (Medium)');
  store.update({ mode: null, spec: null, autonomy: null });
  assert.deepEqual(store.read(), {});
  assert.deepEqual(sanitizeDefaults({ mode: 'yolo', autonomy: 'high', spec: 'yes' }), {});
  // Another folder does not see this folder's defaults.
  store.update({ autonomy: 'low' });
  const other = workspace(t);
  assert.deepEqual(projectDefaultsStore(other, path.join(state, 'project-defaults')).read(), {});
});
