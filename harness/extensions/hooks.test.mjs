import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadHooksFile, matchesHookTool, registerHooks } from './hooks.ts';

test('matchesHookTool supports wildcards, bare names, pi_safe_ names, and pipe-separated Claude Code matchers', () => {
  assert.equal(matchesHookTool(undefined, 'pi_safe_edit'), true);
  assert.equal(matchesHookTool('*', 'pi_safe_bash'), true);
  assert.equal(matchesHookTool('edit', 'pi_safe_edit'), true);
  assert.equal(matchesHookTool('Edit|Write', 'pi_safe_write'), true);
  assert.equal(matchesHookTool('Edit|Write', 'pi_safe_read'), false);
  assert.equal(matchesHookTool('mcp__github__*', 'mcp__github__list_issues'), true);
  assert.equal(matchesHookTool('mcp__github__*', 'mcp__ddg__search'), false);
});

test('loadHooksFile enforces outside-workspace, non-symlink, 0600 private permissions, and parses nested/flat formats', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-hooks-cfg-'));
  const workspace = path.join(root, 'workspace');
  const cfgDir = path.join(root, 'config');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });

  try {
    // Missing file -> present: false, no error
    const missingRes = loadHooksFile(path.join(cfgDir, 'missing.json'), workspace);
    assert.equal(missingRes.present, false);
    assert.equal(missingRes.error, undefined);

    // Inside workspace -> rejected
    const insideFile = path.join(workspace, 'hooks.json');
    writeFileSync(insideFile, JSON.stringify({ Stop: [{ command: 'true' }] }), { mode: 0o600 });
    const insideRes = loadHooksFile(insideFile, workspace);
    assert.match(insideRes.error ?? '', /outside the project workspace/);

    // World-readable -> rejected
    const openFile = path.join(cfgDir, 'open-hooks.json');
    writeFileSync(openFile, JSON.stringify({ Stop: [{ command: 'true' }] }), { mode: 0o644 });
    chmodSync(openFile, 0o644);
    const openRes = loadHooksFile(openFile, workspace);
    assert.match(openRes.error ?? '', /private permissions/);

    // Symlink -> rejected
    const realFile = path.join(cfgDir, 'real-hooks.json');
    writeFileSync(realFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'check-edit' }] }],
        PostToolUse: [{ matcher: 'edit', command: 'fmt', writable: true, timeout: 15 }],
        Stop: [{ command: 'lint' }],
        SessionStart: [{ command: 'banner' }],
      },
    }), { mode: 0o600 });
    chmodSync(realFile, 0o600);
    const linkFile = path.join(cfgDir, 'link-hooks.json');
    symlinkSync(realFile, linkFile);
    const linkRes = loadHooksFile(linkFile, workspace);
    assert.match(linkRes.error ?? '', /non-symlink/);

    // Valid 0600 config -> parsed cleanly
    const validRes = loadHooksFile(realFile, workspace);
    assert.equal(validRes.error, undefined);
    assert.equal(validRes.hooks.PreToolUse.length, 1);
    assert.equal(validRes.hooks.PreToolUse[0].matcher, 'Edit|Write');
    assert.equal(validRes.hooks.PostToolUse[0].writable, true);
    assert.equal(validRes.hooks.PostToolUse[0].timeoutSec, 15);
    assert.equal(validRes.hooks.Stop.length, 1);
    assert.equal(validRes.hooks.SessionStart.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registerHooks wires SessionStart, PreToolUse blocking with stderr, PostToolUse write gating, and Stop single-continuation cap', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-hooks-run-'));
  const workspace = path.join(root, 'workspace');
  const cfgDir = path.join(root, 'config');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const hooksFile = path.join(cfgDir, 'hooks.json');

  writeFileSync(hooksFile, JSON.stringify({
    SessionStart: [{ command: 'session-banner' }],
    PreToolUse: [{ matcher: 'edit|write', command: 'guard-edit' }],
    PostToolUse: [{ matcher: 'edit', command: 'format-after-edit', writable: true }],
    Stop: [{ command: 'run-lint' }],
  }), { mode: 0o600 });
  chmodSync(hooksFile, 0o600);

  try {
    const handlers = new Map();
    const commands = new Map();
    const calls = [];
    const audits = [];
    const notices = [];
    let writableAllowed = true;
    let invalidated = 0;
    let checkpointCalls = 0;
    let guardFail = true;
    let lintFail = true;

    const handle = registerHooks(
      {
        on: (ev, fn) => handlers.set(ev, fn),
        registerCommand: (name, def) => commands.set(name, def.handler),
      },
      {
        enabled: true,
        hooksFile,
        workspaceRoot: workspace,
        canWrite: () => writableAllowed,
        ensureWriteCheckpoint: async () => {
          checkpointCalls++;
          return true;
        },
        onAfterWritableHook: () => { invalidated++; },
        onAudit: entry => audits.push(entry),
        runSandboxShell: async (command, cwd, stdinJson, timeoutSec, forceReadonly) => {
          calls.push({ command, cwd, payload: JSON.parse(stdinJson), timeoutSec, forceReadonly });
          if (command === 'session-banner') {
            return { code: 0, stdout: 'Environment ready\n', stderr: '' };
          }
          if (command === 'guard-edit') {
            return guardFail
              ? { code: 2, stdout: '', stderr: 'Policy violation: missing ticket header\n' }
              : { code: 0, stdout: '', stderr: '' };
          }
          if (command === 'format-after-edit') {
            return { code: 0, stdout: 'Formatted 1 file\n', stderr: '' };
          }
          if (command === 'run-lint') {
            return lintFail
              ? { code: 1, stdout: 'src/app.ts:4: unused var\n', stderr: 'Lint failed\n' }
              : { code: 0, stdout: 'All checks passed!\n', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    );

    const ctx = {
      cwd: workspace,
      hasUI: true,
      ui: { notify: msg => notices.push(msg) },
    };

    // 1. SessionStart runs read-only and queues one-shot context for before_agent_start
    await handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'session-banner');
    assert.equal(calls[0].forceReadonly, true);

    const startRes = await handlers.get('before_agent_start')({ type: 'before_agent_start', messageType: 'user' }, ctx);
    assert.match(startRes.message.content, /Environment ready/);
    const startRes2 = await handlers.get('before_agent_start')({ type: 'before_agent_start', messageType: 'user' }, ctx);
    assert.equal(startRes2, undefined);

    // 2. PreToolUse non-zero exit blocks matching tool with stderr reason; non-matching tool skips hook
    const readRes = await handlers.get('tool_call')({
      type: 'tool_call',
      toolName: 'pi_safe_read',
      toolCallId: 'c1',
      input: { path: 'a.txt' },
    }, ctx);
    assert.equal(readRes, undefined);

    const blockedEdit = await handlers.get('tool_call')({
      type: 'tool_call',
      toolName: 'pi_safe_edit',
      toolCallId: 'c2',
      input: { path: 'a.txt' },
    }, ctx);
    assert.equal(blockedEdit.block, true);
    assert.match(blockedEdit.reason, /missing ticket header/);
    assert.equal(audits.at(-1).rule, 'hook-pre-tool-block');
    // PreToolUse did not opt into writable -> ran read-only
    assert.equal(calls.at(-1).forceReadonly, true);

    guardFail = false;
    const allowedEdit = await handlers.get('tool_call')({
      type: 'tool_call',
      toolName: 'pi_safe_edit',
      toolCallId: 'c3',
      input: { path: 'a.txt' },
    }, ctx);
    assert.equal(allowedEdit, undefined);

    // 3. PostToolUse with writable: true runs writable when mode allows, and falls back to read-only when mode forbids
    const postRes = await handlers.get('tool_result')({
      type: 'tool_result',
      toolName: 'pi_safe_edit',
      toolCallId: 'c3',
      input: { path: 'a.txt' },
      content: [{ type: 'text', text: 'Edited a.txt' }],
      isError: false,
    }, ctx);
    assert.equal(calls.at(-1).command, 'format-after-edit');
    assert.equal(calls.at(-1).forceReadonly, false);
    assert.equal(checkpointCalls, 1);
    assert.equal(invalidated, 1);
    assert.match(postRes.content.at(-1).text, /Formatted 1 file/);

    writableAllowed = false; // e.g. plan mode or read-only fallback
    await handlers.get('tool_result')({
      type: 'tool_result',
      toolName: 'pi_safe_edit',
      toolCallId: 'c4',
      input: { path: 'a.txt' },
      content: [{ type: 'text', text: 'Edited a.txt' }],
      isError: false,
    }, ctx);
    assert.equal(calls.at(-1).forceReadonly, true);

    // 4. Stop hook requests at most ONE continuation per user run
    const settle1 = await handlers.get('agent_before_settle')({
      type: 'agent_before_settle',
      outcome: 'completed',
    }, ctx);
    assert.equal(settle1.continue, true);
    assert.equal(settle1.entries[0].type, 'custom_message');
    assert.match(settle1.entries[0].content, /Lint failed/);
    assert.match(settle1.entries[0].content, /unused var/);

    // Second settle in same user run with lint still failing -> capped at 1 continuation (continue: false)!
    const settle2 = await handlers.get('agent_before_settle')({
      type: 'agent_before_settle',
      outcome: 'completed',
    }, ctx);
    assert.equal(settle2.continue, false);
    assert.equal(settle2.entries[0].type, 'custom');

    // Next user prompt resets the cap; if lint passes (exit 0 + non-JSON stdout), settles cleanly!
    await handlers.get('before_agent_start')({ type: 'before_agent_start', messageType: 'user' }, ctx);
    lintFail = false;
    const settle3 = await handlers.get('agent_before_settle')({
      type: 'agent_before_settle',
      outcome: 'completed',
    }, ctx);
    assert.equal(settle3, undefined);

    assert.match(handle.statusLine(), /active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
