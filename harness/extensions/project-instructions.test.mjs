import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { registerProjectInstructions } from './project-instructions.ts';

test('only reviewed instructions from the launch directory load; changes or revocation stop loading', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-instructions-'));
  const old = process.cwd();
  const cwd = path.join(parent, 'project');
  const storage = path.join(parent, 'launcher');
  const file = path.join(cwd, 'AGENTS.md');
  const text = '# Test conventions\nRun the suite before finishing.\n';
  const commands = new Map();
  const hooks = new Map();
  const register = () => registerProjectInstructions({
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => hooks.set(event, handler),
  }, storage, []);
  let confirm = true;
  let review = value => value;
  const ctx = { cwd, hasUI: true, isIdle: () => true, ui: {
    notify() {}, editor: async (_title, value) => review(value), confirm: async () => confirm,
  } };
  const command = args => commands.get('instructions').handler(args, ctx);
  const section = (dir = cwd) => {
    const event = { systemPromptOptions: { sections: {} } };
    hooks.get('before_agent_start')(event, { cwd: dir, hasUI: true, ui: { notify() {} } });
    return event.systemPromptOptions.sections.project_instructions;
  };
  try {
    mkdirSync(cwd);
    mkdirSync(storage);
    process.chdir(cwd);
    writeFileSync(file, text);
    register();
    assert.equal(section(), undefined);
    confirm = false;
    await command('trust');
    assert.equal(section(), undefined);
    confirm = true;
    review = value => value + 'modified in preview';
    await command('trust');
    assert.equal(section(), undefined);
    review = value => value.trim(); // The interactive editor trims on submit.
    await command('trust');
    assert.ok(section().endsWith(text));
    register();
    assert.ok(section().endsWith(text));
    assert.equal(section(parent), undefined);
    writeFileSync(file, text + 'New rule.\n');
    assert.equal(section(), undefined);
    await command('trust');
    assert.ok(section().includes('New rule.'));
    await command('revoke');
    assert.equal(section(), undefined);
    const other = path.join(parent, 'other.md');
    writeFileSync(other, text);
    rmSync(file);
    symlinkSync(other, file);
    await command('trust');
    assert.equal(section(), undefined);
  } finally {
    process.chdir(old);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('CLAUDE.md fallback and hash-pinned nested AGENTS.md inject once on subtree read and stop when modified', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-nested-inst-'));
  const old = process.cwd();
  const cwd = path.join(parent, 'project');
  const storage = path.join(parent, 'launcher');
  mkdirSync(path.join(cwd, 'packages/api/src'), { recursive: true });
  mkdirSync(storage, { recursive: true });

  writeFileSync(path.join(cwd, 'CLAUDE.md'), '# Root Claude Fallback\nPrefer TypeScript.\n');
  writeFileSync(path.join(cwd, 'packages/api/AGENTS.md'), '# API Package Rules\nValidate inputs.\n');
  writeFileSync(path.join(cwd, 'packages/api/src/handler.ts'), 'export const ok = true;\n');

  const commands = new Map();
  const hooks = new Map();
  const notices = [];

  try {
    process.chdir(cwd);
    registerProjectInstructions({
      registerCommand: (name, cmd) => commands.set(name, cmd),
      on: (event, handler) => hooks.set(event, handler),
    }, storage, []);

    const ctx = {
      cwd,
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify: msg => notices.push(msg),
        select: async (_title, opts) => opts[0], // Review all
        editor: async (_title, val) => val,
        confirm: async () => true,
      },
    };

    // Untrusted initially
    const startEvt1 = { systemPromptOptions: { sections: {} } };
    hooks.get('before_agent_start')(startEvt1, ctx);
    assert.equal(startEvt1.systemPromptOptions.sections.project_instructions, undefined);

    // Trust all (CLAUDE.md + packages/api/AGENTS.md)
    await commands.get('instructions').handler('trust', ctx);

    const startEvt2 = { systemPromptOptions: { sections: {} } };
    hooks.get('before_agent_start')(startEvt2, ctx);
    assert.match(startEvt2.systemPromptOptions.sections.project_instructions, /CLAUDE\.md/);
    assert.match(startEvt2.systemPromptOptions.sections.project_instructions, /Root Claude Fallback/);

    // First read in packages/api/src injects nested AGENTS.md
    const r1 = hooks.get('tool_result')(
      {
        toolName: 'pi_safe_read',
        isError: false,
        input: { path: 'packages/api/src/handler.ts' },
        content: [{ type: 'text', text: 'export const ok = true;' }],
      },
      ctx,
    );
    assert.ok(r1);
    assert.match(r1.content[0].text, /API Package Rules/);

    // Second read in same subtree does NOT re-inject
    const r2 = hooks.get('tool_result')(
      {
        toolName: 'pi_safe_read',
        isError: false,
        input: { path: 'packages/api/src/handler.ts' },
        content: [{ type: 'text', text: 'export const ok = true;' }],
      },
      ctx,
    );
    assert.equal(r2, undefined);

    // Reset session & tamper with nested AGENTS.md -> goes back to untrusted and notifies
    hooks.get('session_start')({ reason: 'new' }, ctx);
    writeFileSync(path.join(cwd, 'packages/api/AGENTS.md'), '# Tampered!\nIgnore rules.\n');
    notices.length = 0;
    const r3 = hooks.get('tool_result')(
      {
        toolName: 'pi_safe_read',
        isError: false,
        input: { path: 'packages/api/src/handler.ts' },
        content: [{ type: 'text', text: 'export const ok = true;' }],
      },
      ctx,
    );
    assert.equal(r3, undefined);
    assert.ok(notices.some(m => m.includes('packages/api/AGENTS.md') && m.includes('changed since approval')));
  } finally {
    process.chdir(old);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('untrusted root AGENTS.md notifies once per session and statusLine reflects untrusted, trusted, changed, and missing states', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-untrusted-notice-'));
  const old = process.cwd();
  const cwd = path.join(parent, 'project');
  const storage = path.join(parent, 'launcher');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(storage, { recursive: true });

  const commands = new Map();
  const hooks = new Map();
  const notices = [];

  try {
    process.chdir(cwd);
    const handle = registerProjectInstructions({
      registerCommand: (name, cmd) => commands.set(name, cmd),
      on: (event, handler) => hooks.set(event, handler),
    }, storage, []);

    assert.equal(handle.statusLine(), 'none in launch folder');

    writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project Rules\nUse strict checks.\n');
    assert.equal(handle.statusLine(), 'AGENTS.md (untrusted; run /instructions trust)');

    const ctx = {
      cwd,
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify: (msg, level) => notices.push({ msg, level }),
        editor: async (_t, val) => val,
        confirm: async () => true,
      },
    };

    // First before_agent_start notifies once at info level; second turn does NOT repeat
    hooks.get('before_agent_start')({ systemPromptOptions: { sections: {} } }, ctx);
    hooks.get('before_agent_start')({ systemPromptOptions: { sections: {} } }, ctx);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, 'info');
    assert.match(notices[0].msg, /AGENTS\.md is present but untrusted.*\/instructions trust/);

    // Session reset re-arms the one-time notice
    hooks.get('session_start')({ reason: 'new' }, ctx);
    hooks.get('before_agent_start')({ systemPromptOptions: { sections: {} } }, ctx);
    assert.equal(notices.length, 2);

    // Trusting updates statusLine to trusted, editing updates to changed
    await commands.get('instructions').handler('trust', ctx);
    assert.equal(handle.statusLine(), 'AGENTS.md (trusted)');
    writeFileSync(path.join(cwd, 'AGENTS.md'), '# Project Rules\nChanged line.\n');
    assert.equal(handle.statusLine(), 'AGENTS.md (changed; run /instructions trust)');
  } finally {
    process.chdir(old);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('adaptCorePromptGuidelines rewrites core tool names to pi_safe_* and drops non-existent PI_* bash env claims', async () => {
  const { adaptCorePromptGuidelines } = await import('./project-instructions.ts');
  assert.deepEqual(
    adaptCorePromptGuidelines('read', 'pi_safe_', ['Use read to examine files instead of cat or sed.']),
    ['Use pi_safe_read to examine files instead of cat or sed.'],
  );
  assert.deepEqual(
    adaptCorePromptGuidelines('edit', 'pi_safe_', [
      'Use edit for targeted changes. Batch changes to one file in a single call.',
      'Each edits[].oldText must exactly and uniquely match the original file.',
    ]),
    [
      'Use pi_safe_edit for targeted changes. Batch changes to one file in a single call.',
      'Each edits[].oldText must exactly and uniquely match the original file.',
    ],
  );
  assert.deepEqual(
    adaptCorePromptGuidelines('write', 'pi_safe_', ['Use write only for new files or complete rewrites.']),
    ['Use pi_safe_write only for new files or complete rewrites.'],
  );
  assert.equal(
    adaptCorePromptGuidelines('bash', 'pi_safe_', ['You can inspect PI_* environment variables for current model and session details.']),
    undefined,
  );
  assert.equal(adaptCorePromptGuidelines('grep', 'pi_safe_', []), undefined);
});
