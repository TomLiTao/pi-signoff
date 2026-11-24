import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { memoryToolName, registerMemory } from './memory.ts';

test('opt-in memory enforces per-file/total caps, emits visible diffs, and respects --no-memory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-mem-test-'));
  const old = process.cwd();
  const project = path.join(root, 'proj');
  const memBase = path.join(root, 'state');
  mkdirSync(project);

  try {
    process.chdir(project);
    let registeredTool = null;
    const commands = new Map();
    const hooks = new Map();
    const messages = [];
    let activeTools = [memoryToolName, 'pi_safe_read'];

    const handle = registerMemory(
      {
        registerTool: t => { registeredTool = t; },
        registerCommand: (n, c) => commands.set(n, c.handler),
        on: (e, h) => hooks.set(e, h),
        getActiveTools: () => activeTools,
        setActiveTools: next => { activeTools = next; },
        sendMessage: msg => messages.push(msg),
      },
      {
        mode: 'off',
        baseDir: memBase,
        isPlanning: () => false,
        runRead: fn => fn(),
        runWrite: fn => fn(),
      },
    );

    assert.equal(handle.isEnabled(), false);
    hooks.get('session_start')();
    assert.equal(activeTools.includes(memoryToolName), false);

    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        notify() {},
        confirm: async () => true,
        editor: async (_t, v) => v,
      },
    };

    // Enable via /memory on
    await commands.get('memory')('on', ctx);
    assert.equal(handle.isEnabled(), true);
    assert.equal(activeTools.includes(memoryToolName), true);

    // Write MEMORY.md and topic file
    const w1 = await registeredTool.execute('1', { action: 'write', file: 'MEMORY.md', content: '- Test runner: node --test\n' }, undefined, undefined, ctx);
    assert.match(w1.content[0].text, /\+- Test runner: node --test/);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, 'pi-memory-diff');

    // Enforce 2 KB topic file cap
    await assert.rejects(
      () => registeredTool.execute('2', { action: 'write', file: 'huge.md', content: 'x'.repeat(2100) }, undefined, undefined, ctx),
      /exceeds its 2048-byte limit/,
    );

    // Reject path traversal
    await assert.rejects(
      () => registeredTool.execute('3', { action: 'write', file: '../escape.md', content: 'bad' }, undefined, undefined, ctx),
      /Memory file name/,
    );

    // Injects into sections.memory on before_agent_start
    const evt = { systemPromptOptions: { sections: {} } };
    hooks.get('before_agent_start')(evt, ctx);
    assert.match(evt.systemPromptOptions.sections.memory, /node --test/);

    // Hard-off (--no-memory) never registers tool and refuses /memory on
    let hardTool = null;
    const hardCmds = new Map();
    const hardNotices = [];
    const hardHandle = registerMemory(
      {
        registerTool: t => { hardTool = t; },
        registerCommand: (n, c) => hardCmds.set(n, c.handler),
        on: () => {},
        getActiveTools: () => [],
        setActiveTools: () => {},
        sendMessage: () => {},
      },
      {
        mode: 'never',
        baseDir: memBase,
        isPlanning: () => false,
        runRead: fn => fn(),
        runWrite: fn => fn(),
      },
    );
    assert.equal(hardTool, null);
    await hardCmds.get('memory')('on', { ...ctx, ui: { ...ctx.ui, notify: m => hardNotices.push(m) } });
    assert.equal(hardHandle.isEnabled(), false);
    assert.match(hardNotices[0], /--no-memory/);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});
