import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseNotifyMode, parseStyleMarkdown, registerPreferences } from './preferences.ts';

test('parseStyleMarkdown and parseNotifyMode validate inputs and reject reserved/control characters', () => {
  assert.equal(parseNotifyMode('off'), 'off');
  assert.equal(parseNotifyMode('prompts'), 'prompts');
  assert.equal(parseNotifyMode('bell'), 'all');
  assert.equal(parseNotifyMode('all'), 'all');
  assert.equal(parseNotifyMode('loud'), null);

  const custom = parseStyleMarkdown(
    `---\nname: staff-review\ndescription: "Executive bullet brief"\n---\nLead with risk summary and bullet action items.\n`,
    'staff-review',
  );
  assert.equal(custom.name, 'staff-review');
  assert.equal(custom.source, 'user');
  assert.match(custom.instructions, /Output Style \(staff-review\):/);

  assert.throws(() => parseStyleMarkdown('Body', 'default'), /reserved/);
  assert.throws(() => parseStyleMarkdown('Bad \u202E body', 'bad'), /hidden or control/);
});

test('registerPreferences persists style/notify outside workspace, injects output_style, and rings bell ONLY in tui mode', async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-prefs-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  const prefsFile = path.join(base, 'config', 'preferences.json');
  const stylesDir = path.join(base, 'config', 'styles');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(stylesDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stylesDir, 'pirate-clean.md'),
    `---\ndescription: Direct checklist style\n---\nAlways end with a verification checklist.\n`,
    { mode: 0o600 },
  );

  const commands = new Map();
  const handlers = new Map();
  let bells = 0;
  const fakePi = {
    registerCommand(name, def) { commands.set(name, def); },
    on(ev, fn) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
  };

  const handle = registerPreferences(fakePi, {
    cwd,
    prefsFile,
    stylesDir,
    emitBell: () => { bells++; },
  });

  assert.equal(handle.getStyle(), 'default');
  assert.equal(handle.getNotifyMode(), 'off');
  assert.ok(handle.listStyles().some(s => s.name === 'pirate-clean'));

  const tuiCtx = { cwd, mode: 'tui', hasUI: true, ui: { notify() {} } };
  const rpcCtx = { cwd, mode: 'rpc', hasUI: true, ui: { notify() {} } };

  // Switch style and notify via commands
  await commands.get('style').handler('concise', tuiCtx);
  await commands.get('notify').handler('all', tuiCtx);
  assert.equal(handle.getStyle(), 'concise');
  assert.equal(handle.getNotifyMode(), 'all');

  // Guard missing systemPromptOptions on synthetic before_agent_start
  for (const fn of handlers.get('before_agent_start') ?? []) {
    await fn({ type: 'before_agent_start', messageType: 'user' }, tuiCtx);
  }
  const sysEvt = { type: 'before_agent_start', messageType: 'user', systemPromptOptions: { sections: {} } };
  for (const fn of handlers.get('before_agent_start') ?? []) {
    await fn(sysEvt, tuiCtx);
  }
  assert.match(sysEvt.systemPromptOptions.sections.output_style, /Output Style \(concise\)/);

  // Bell NEVER fires in RPC mode (protects JSON-RPC stdout/stderr cleanliness!)
  for (const fn of handlers.get('ui_prompt_start') ?? []) {
    await fn({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }, rpcCtx);
  }
  for (const fn of handlers.get('agent_settled') ?? []) {
    await fn({ type: 'agent_settled', aborted: false }, rpcCtx);
  }
  assert.equal(bells, 0);

  // Bell DOES fire in TUI mode on prompt and non-aborted settle
  for (const fn of handlers.get('ui_prompt_start') ?? []) {
    await fn({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'select' }, tuiCtx);
  }
  for (const fn of handlers.get('agent_settled') ?? []) {
    await fn({ type: 'agent_settled', aborted: false }, tuiCtx);
  }
  for (const fn of handlers.get('agent_settled') ?? []) {
    await fn({ type: 'agent_settled', aborted: true }, tuiCtx);
  }
  assert.equal(bells, 2);

  // Reloading from prefsFile restores saved style & notify
  const handle2 = registerPreferences(fakePi, { cwd, prefsFile, stylesDir });
  assert.equal(handle2.getStyle(), 'concise');
  assert.equal(handle2.getNotifyMode(), 'all');
});
