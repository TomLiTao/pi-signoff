import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerShellApprovals, shellApprovalStore } from './shell-approvals.ts';

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-shell-approvals-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [launch, other, install] = ['project', 'other', 'launcher'].map(name => path.join(base, name));
  for (const dir of [launch, other, install]) mkdirSync(dir);
  return { base, launch, other, install, storage: path.join(install, 'shell-approvals') };
}

test('saved shell approval is exact, scoped to the launch folder, and revocable', t => {
  const { base, launch, other, install, storage } = fixture(t);
  const store = shellApprovalStore(install, launch);
  assert.equal(store.allows('npm test'), false);
  store.add('npm test');
  const next = shellApprovalStore(install, launch);
  assert.equal(next.allows('npm test'), true);
  for (const command of ['npm test ', 'npm test -- --watch', 'npm test && npm run build']) {
    assert.equal(next.allows(command), false);
  }
  assert.equal(shellApprovalStore(install, other).allows('npm test'), false);
  const link = path.join(base, 'alias');
  symlinkSync(launch, link);
  assert.equal(next.inProject(link), true);
  assert.equal(next.inProject(other), false);
  assert.equal(statSync(storage).mode & 0o777, 0o700);
  const [record] = readdirSync(storage);
  assert.equal(statSync(path.join(storage, record)).mode & 0o777, 0o600);
  const [{ id, command }] = next.list();
  assert.equal(command, 'npm test');
  assert.equal(next.revoke(id.slice(0, 12)), true);
  assert.equal(store.allows(command), false);
  assert.deepEqual(store.list(), []);
});

test('unsafe, damaged and symlinked approval stores are not trusted', t => {
  const { launch, install, storage } = fixture(t);
  assert.throws(() => shellApprovalStore(launch, launch), /outside the workspace/);
  const store = shellApprovalStore(install, launch);
  store.add('npm test');
  chmodSync(storage, 0o755);
  assert.equal(store.allows('npm test'), false);
  assert.throws(() => store.add('npm test'), /private/);
  chmodSync(storage, 0o700);
  const [record] = readdirSync(storage);
  const file = path.join(storage, record);
  writeFileSync(file, JSON.stringify('npm run lint'));
  assert.equal(store.allows('npm test'), false);
  assert.equal(store.list()[0].command, undefined);
  const target = path.join(install, 'linked.json');
  writeFileSync(target, JSON.stringify('npm test'), { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  assert.equal(store.allows('npm test'), false);
  assert.equal(store.revoke(store.list()[0].id), true);
  rmSync(storage, { recursive: true });
  symlinkSync(launch, storage);
  assert.equal(store.allows('npm test'), false);
  assert.throws(() => store.add('npm test'), /private/);
});

test('/approvals lists and revokes through the extension command', async t => {
  const { launch, install } = fixture(t);
  const old = process.cwd();
  let handler;
  let store;
  const registered = new Map();
  try {
    process.chdir(launch);
    store = registerShellApprovals({ registerCommand: (name, command) => {
      registered.set(name, command.handler);
    } }, install);
    handler = registered.get('approvals');
  } finally {
    process.chdir(old);
  }
  assert.ok(registered.has('permissions'));
  assert.ok(registered.has('approvals'));
  const notices = [];
  const ctx = { cwd: launch, ui: { notify: message => notices.push(message) } };
  store.add('npm test');
  await handler('', ctx);
  assert.match(notices.at(-1), /[a-f0-9]{12}  "npm test"/);
  const [{ id }] = store.list();
  await handler(`revoke ${id.slice(0, 12)}`, ctx);
  assert.match(notices.at(-1), /revoked/);
  assert.equal(store.allows('npm test'), false);
});

test('/permissions displays exact, prefix, deny, askPaths, mode, and deny wins over saved prefix/exact', async t => {
  const { launch, install } = fixture(t);
  const { loadEditPolicy } = await import('./approvals.ts');
  const fullPolicy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));
  const old = process.cwd();
  const commands = new Map();
  let store;
  try {
    process.chdir(launch);
    store = registerShellApprovals(
      { registerCommand: (name, cmd) => commands.set(name, cmd.handler) },
      install,
      { getPolicy: () => fullPolicy, getMode: () => 'ask-edits' },
    );
  } finally {
    process.chdir(old);
  }

  store.add('make build');
  store.addPrefix(['npm', 'test'], fullPolicy.neverSessionAllow);
  assert.deepEqual(store.evaluate('npm test -- --bail', fullPolicy), { decision: 'allow', kind: 'saved-prefix' });
  assert.deepEqual(store.evaluate('npm test-other', fullPolicy), { decision: 'ask' });

  // Add a custom deny rule that overrides the saved prefix
  const notices = [];
  const ctx = { cwd: launch, ui: { notify: msg => notices.push(msg) } };
  await commands.get('permissions')('deny npm test --watch', ctx);
  assert.equal(store.evaluate('npm test --watch', fullPolicy).decision, 'deny');
  assert.equal(store.evaluate('npm test --bail', fullPolicy).decision, 'allow');

  // Seeded blockedCommands also win even if an exact command was somehow saved
  store.add('sudo id');
  assert.equal(store.evaluate('sudo id', fullPolicy).decision, 'deny');

  await commands.get('permissions')('', ctx);
  const view = notices.at(-1);
  assert.match(view, /Current mode: ask-edits/);
  assert.match(view, /Saved exact rules/);
  assert.match(view, /Saved prefix rules/);
  assert.match(view, /"npm test …"/);
  assert.match(view, /Deny rules/);
  assert.match(view, /askPaths/);
});
