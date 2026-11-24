import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { linkSync } from 'node:fs';
import { loadEditPolicy } from './approvals.ts';
import {
  codeBlocks,
  desktopDisplayIssue,
  inspectInstallation,
  registerCopy,
  registerDoctor,
  registerOpen,
  validateWorkspaceOpenTarget,
} from './desktop.ts';

const answer = 'Try this:\n```js\nconsole.log(1)\n```\n\n  ~~~~sh\n  printf hi\n ~~~\n  ~~~~';
const final = { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [
  { type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: answer },
] } };
const toolCall = { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [
  { type: 'text', text: 'Interim update' },
] } };

function harness() {
  const commands = new Map();
  const notes = [];
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, ui: { notify: text => notes.push(text) },
    sessionManager: { getBranch: () => [final, toolCall] } };
  return { ctx, commands, notes, pi: { registerCommand: (name, command) => commands.set(name, command.handler),
    getActiveTools: () => ['pi_safe_read'], on: () => {}, appendEntry: () => {} } };
}

function fixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-desktop-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'src');
  const installed = path.join(base, 'installed');
  mkdirSync(source);
  mkdirSync(installed);
  const manifest = (id, from = 'source.ts') => writeFileSync(path.join(installed, 'install-source'),
    [source, id, from, 'installed.ts', ''].join('\0'));
  manifest('first');
  writeFileSync(path.join(source, 'source.ts'), 'original');
  writeFileSync(path.join(installed, 'installed.ts'), 'original');
  return { source, installed, manifest };
}

test('installation comparison reports source changes, reinstall, and invalid input without following links', t => {
  const { source, installed, manifest } = fixture(t);
  assert.equal(inspectInstallation(installed, 'first'), 'matches source checkout');
  writeFileSync(path.join(source, 'source.ts'), 'updated');
  assert.match(inspectInstallation(installed, 'first'), /out of sync.*installed\.ts/);
  manifest('second');
  assert.match(inspectInstallation(installed, 'first'), /reinstalled since startup/);
  assert.match(inspectInstallation(installed), /out of sync/);
  rmSync(path.join(source, 'source.ts'));
  symlinkSync(path.join(installed, 'installed.ts'), path.join(source, 'source.ts'));
  assert.match(inspectInstallation(installed), /out of sync/);
  manifest('second', '../installed/installed.ts');
  assert.match(inspectInstallation(installed), /could not compare/);
});

test('fenced code selects only complete blocks and preserves code whitespace', () => {
  assert.deepEqual(codeBlocks(answer), ['console.log(1)\n', 'printf hi\n~~~\n']);
  assert.deepEqual(codeBlocks('```txt\nnot closed'), []);
  assert.deepEqual(codeBlocks('````\n```\n  indented\n`````'), ['```\n  indented\n']);
});

test('copy writes only the selected text, and refuses to run in RPC mode', async () => {
  const { pi, commands, ctx, notes } = harness();
  const copied = [];
  registerCopy(pi, id => { assert.equal(id, 3); return 'some output\n'; }, async text => { copied.push(text); });
  assert.equal(commands.has('copy'), false);
  const copy = commands.get('clip');
  await copy('', ctx);
  await copy('code', ctx);
  await copy('code 2', ctx);
  await copy('job 3', ctx);
  await copy('', { ...ctx, mode: 'rpc' });
  assert.match(notes.at(-1), /requires the interactive Pi terminal/);
  await copy('code 4', ctx);
  assert.match(notes.at(-1), /from 1 to 2/);
  assert.deepEqual(copied, [answer, 'console.log(1)\n', 'printf hi\n~~~\n', 'some output\n']);
  await copy('', { ...ctx, sessionManager: { getBranch: () => [toolCall] } });
  assert.match(notes.at(-1), /No assistant answer/);
});

test('doctor reports local state without prompting a provider, even when the sandbox probe fails', async t => {
  const { installed } = fixture(t);
  const { pi, commands, ctx, notes } = harness();
  const probes = [];
  registerDoctor(pi, { dir: installed, isPlanning: () => true, async probeSandbox(cwd) {
    probes.push(cwd);
    throw new Error('do not include subprocess error text');
  } });
  const model = { provider: 'test-example', id: 'model' };
  await commands.get('doctor')('unexpected', ctx);
  assert.deepEqual(probes, []);
  await commands.get('doctor')('', { ...ctx, model, thinkingLevel: 'low' });
  assert.equal(probes.length, 1);
  const report = notes.at(-1);
  assert.match(report, /no provider request/);
  assert.match(report, /Install: matches source checkout/);
  assert.match(report, /Sandbox: read-only probe failed/);
  assert.match(report, /Checkpoint: not created at launch/);
  assert.match(report, /Workspace policy: read-only \(plan\)/);
  assert.match(report, /Model: test-example\/model \(thinking: low\)/);
assert.match(report, /Active model tools: pi_safe_read/);
  assert.doesNotMatch(report, /subprocess error text/);
});

test('doctor reports collapsed hardlink mask directories and instructions status when present', async t => {
  const { installed } = fixture(t);
  const { pi, commands, ctx, notes } = harness();
  registerDoctor(pi, {
    dir: installed,
    isPlanning: () => false,
    probeSandbox: async () => true,
    inspectCollapsed: async () => ['.venv'],
    instructionsStatus: () => 'AGENTS.md (untrusted; run /instructions trust)',
  });
  await commands.get('doctor')('', ctx);
  assert.match(notes.at(-1), /Collapsed mask dirs: \.venv \(masked as empty; use UV_LINK_MODE=copy/);
  assert.match(notes.at(-1), /Instructions: AGENTS\.md \(untrusted; run \/instructions trust\)/);
});

test('validateWorkspaceOpenTarget enforces non-secret regular viewer files and blocks symlinks, hardlinks, secrets, and executables', t => {
  const policy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));
  const base = mkdtempSync(path.join(tmpdir(), 'pi-open-validate-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  mkdirSync(path.join(cwd, 'decks'), { recursive: true });
  mkdirSync(path.join(cwd, '.git'), { recursive: true });
  mkdirSync(path.join(cwd, '.local'), { recursive: true });

  writeFileSync(path.join(cwd, 'decks/pitch.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  writeFileSync(path.join(cwd, 'decks/report.pdf'), '%PDF-1.7\n');
  writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(cwd, '.env.md'), 'SECRET_DISGUISED=1\n');
  writeFileSync(path.join(cwd, '.git/info.md'), '# internal\n');
  writeFileSync(path.join(cwd, '.local/notes.pdf'), '%PDF-1.7\n');
  writeFileSync(path.join(cwd, 'decks/script.sh'), '#!/bin/sh\necho pwn\n');
  writeFileSync(path.join(cwd, 'decks/disguised-shebang.md'), '#!/usr/bin/env bash\necho no\n');
  writeFileSync(path.join(cwd, 'decks/disguised-elf.pdf'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
  symlinkSync(path.join(cwd, 'decks/report.pdf'), path.join(cwd, 'decks/linked.pdf'));
  writeFileSync(path.join(base, 'outside.pdf'), '%PDF-1.7\n');
  writeFileSync(path.join(cwd, 'decks/hard1.pdf'), '%PDF-1.7\n');
  linkSync(path.join(cwd, 'decks/hard1.pdf'), path.join(cwd, 'decks/hard2.pdf'));

  const okPptx = validateWorkspaceOpenTarget(cwd, 'decks/pitch.pptx', policy);
  assert.equal(okPptx.relPosix, 'decks/pitch.pptx');
  assert.equal(okPptx.ext, '.pptx');
  const okPdf = validateWorkspaceOpenTarget(cwd, '@decks/report.pdf', policy);
  assert.equal(okPdf.relPosix, 'decks/report.pdf');

  assert.throws(() => validateWorkspaceOpenTarget(cwd, '../outside.pdf', policy), /strictly inside the current workspace/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'https://example.com/a.pdf', policy), /not URLs/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, '~/Desktop/a.pdf', policy), /not URLs or home paths/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, '.env', policy), /protected by policy/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, '.env.md', policy), /protected by policy/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, '.git/info.md', policy), /Protected workspace paths/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, '.local/notes.pdf', policy), /Protected workspace paths/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/script.sh', policy), /Unsupported file type/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/linked.pdf', policy), /Symbolic links/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/hard1.pdf', policy), /Hardlinked files/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/disguised-shebang.md', policy), /Executable binaries and script files/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/disguised-elf.pdf', policy), /Executable binaries and script files/);
  assert.throws(() => validateWorkspaceOpenTarget(cwd, 'decks/missing.pdf', policy), /File not found/);

  assert.match(desktopDisplayIssue({}), /No host graphical display/);
  assert.equal(desktopDisplayIssue({ WAYLAND_DISPLAY: 'wayland-0' }), undefined);
  assert.equal(desktopDisplayIssue({ DISPLAY: ':0' }), undefined);
});

test('/open launches validated files in interactive TUI mode and refuses RPC mode', async t => {
  const policy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));
  const base = mkdtempSync(path.join(tmpdir(), 'pi-open-cmd-'));
  const oldCwd = process.cwd();
  t.after(() => {
    process.chdir(oldCwd);
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(path.join(base, 'slides'), { recursive: true });
  writeFileSync(path.join(base, 'slides/deck.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  process.chdir(base);
  const { pi, commands, notes } = harness();
  const launched = [];
  registerOpen(pi, {
    getPolicy: () => policy,
    launch: async (absPath, app) => {
      launched.push({ absPath, app });
    },
  });

  const openCmd = commands.get('open');
  const tuiCtx = { cwd: base, mode: 'tui', hasUI: true, ui: { notify: msg => notes.push(msg) } };
  await openCmd('slides/deck.pptx', tuiCtx);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].app, 'default');
  assert.match(notes.at(-1), /Opened "slides\/deck\.pptx" on host desktop\./);

  await openCmd('--libreoffice "slides/deck.pptx"', tuiCtx);
  assert.equal(launched.length, 2);
  assert.equal(launched[1].app, 'libreoffice');
  assert.match(notes.at(-1), /\(LibreOffice\)/);

  await openCmd('slides/deck.pptx', { ...tuiCtx, mode: 'rpc' });
  assert.equal(launched.length, 2);
  assert.match(notes.at(-1), /requires the interactive Pi terminal/);
});
