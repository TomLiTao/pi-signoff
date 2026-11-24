import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadEditPolicy } from './approvals.ts';
import {
  autonomyAllowsEdit,
  autonomyAllowsShell,
  listSavedSpecs,
  nextAutonomyLevel,
  parseAutonomyLevel,
  readSavedSpec,
  registerAutonomy,
  saveSpecMarkdown,
} from './autonomy.ts';

const policy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));

test('autonomyAllowsShell strictly enforces deny policy, blocks operators/find-exec/sed-i, and differentiates off/low/medium', () => {
  assert.equal(parseAutonomyLevel('off'), 'off');
  assert.equal(parseAutonomyLevel('low'), 'low');
  assert.equal(parseAutonomyLevel('med'), 'medium');
  assert.equal(parseAutonomyLevel('high'), null);
  assert.equal(nextAutonomyLevel('off'), 'low');
  assert.equal(nextAutonomyLevel('low'), 'medium');
  assert.equal(nextAutonomyLevel('medium'), 'off');

  // off: nothing auto-approved by autonomy
  assert.equal(autonomyAllowsShell('off', 'git status', policy), null);
  assert.equal(autonomyAllowsShell('off', 'pytest', policy), null);
  assert.equal(autonomyAllowsEdit('off', 'allow'), null);

  // low: safe read-only inspection commands allowed, dev/test commands still ask
  assert.equal(autonomyAllowsShell('low', 'git status', policy), 'auto-low-readonly');
  assert.equal(autonomyAllowsShell('low', 'git diff src/app.ts', policy), 'auto-low-readonly');
  assert.equal(autonomyAllowsShell('low', 'rg TODO src', policy), 'auto-low-readonly');
  assert.equal(autonomyAllowsShell('low', 'find src -name test.ts', policy), 'auto-low-readonly');
  assert.equal(autonomyAllowsShell('low', 'sed -n 1,20p README.md', policy), 'auto-low-readonly');
  assert.equal(autonomyAllowsShell('low', 'pytest tests/unit', policy), null);
  assert.equal(autonomyAllowsShell('low', 'node --test', policy), null);

  // low security blocks: find -delete / -exec, sed -i, git branch -D, shell chaining
  assert.equal(autonomyAllowsShell('low', 'find . -delete', policy), null);
  assert.equal(autonomyAllowsShell('low', 'find . -exec rm {} +', policy), null);
  assert.equal(autonomyAllowsShell('low', 'sed -i s/a/b/ file.txt', policy), null);
  assert.equal(autonomyAllowsShell('low', 'git branch -D main', policy), null);
  assert.equal(autonomyAllowsShell('low', 'git status && rm foo', policy), null);

  // medium: low + allowlisted local dev/test/lint/build commands
  assert.equal(autonomyAllowsShell('medium', 'pytest tests/test_api.py', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'python3 -m pytest -q', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'node --test config/foo.test.mjs', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'npm run typecheck', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'cargo clippy', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'ruff check src', policy), 'auto-medium-dev');

  // medium security blocks: arbitrary python scripts, blockedCommands, neverSessionAllow, ask/deny edits
  assert.equal(autonomyAllowsShell('medium', 'python3 scripts/mutate.py', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'bash -c pytest', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'rm -f build.txt', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'rm -rf dist', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'sudo pytest', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'git commit -m test', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'npm install lodash', policy), null);
  assert.equal(autonomyAllowsShell('medium', 'pytest && curl https://evil.example', policy), null);

  assert.equal(autonomyAllowsEdit('low', 'allow'), 'auto-edit-allow');
  assert.equal(autonomyAllowsEdit('medium', 'allow'), 'auto-edit-allow');
  assert.equal(autonomyAllowsEdit('medium', 'ask'), null);
  assert.equal(autonomyAllowsEdit('medium', 'deny'), null);
});

test('saveSpecMarkdown, listSavedSpecs, readSavedSpec, and registerAutonomy manage spec artifacts and spec thinking', async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-autonomy-spec-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  const specsDir = path.join(base, 'specs');
  mkdirSync(cwd, { recursive: true });

  // Reject specsDir inside workspace
  assert.throws(
    () =>
      saveSpecMarkdown({
        cwd,
        summary: 'Inside repo',
        steps: [{ step: 1, text: 'Bad location', completed: false }],
        autonomyLevel: 'off',
        specsBaseDir: path.join(cwd, '.specs'),
      }),
    /outside the workspace/,
  );

  const saved = saveSpecMarkdown({
    cwd,
    summary: 'Add OAuth PKCE login',
    steps: [
      { step: 1, text: 'Implement PKCE verifier helper', completed: false },
      { step: 2, text: 'Add callback route tests', completed: true },
    ],
    autonomyLevel: 'medium',
    specsBaseDir: specsDir,
  });
  assert.match(saved.fileName, /add-oauth-pkce-login\.md$/);

  const listed = listSavedSpecs(cwd, specsDir);
  assert.deepEqual(listed, [saved.fileName]);

  const loaded = readSavedSpec(cwd, '1', specsDir);
  assert.equal(loaded.fileName, saved.fileName);
  assert.match(loaded.content, /# Spec: Add OAuth PKCE login/);
  assert.match(loaded.content, /`medium`/);
  assert.match(loaded.content, /2\. \[x\] Add callback route tests/);

  // Test registerAutonomy commands + spec thinking override/restore
  const commands = new Map();
  const handlers = new Map();
  let thinking = 'low';
  const entries = [];
  const fakePi = {
    registerShortcut() {},
    registerCommand(name, def) { commands.set(name, def); },
    on(ev, fn) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    appendEntry(type, data) { entries.push({ type: 'custom', customType: type, data }); },
    getThinkingLevel: () => thinking,
    setThinkingLevel: next => { thinking = next; },
  };

  let planning = false;
  const handle = registerAutonomy(fakePi, {
    initialLevel: 'off',
    initialSaveSpecs: true,
    initialSpecThinking: 'high',
    specsBaseDir: specsDir,
    isPlanning: () => planning,
    isWritable: () => true,
    hasPendingWork: () => false,
  });

  planning = true;
  handle.onPlanModeChange(true);
  assert.equal(thinking, 'high');

  planning = false;
  handle.onPlanModeChange(false);
  assert.equal(thinking, 'low');

  const notes = [];
  const ctx = {
    cwd,
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: { notify: msg => notes.push(msg) },
  };

  await commands.get('auto').handler('medium', ctx);
  assert.equal(handle.getLevel(), 'medium');
  await commands.get('auto').handler('high', ctx);
  assert.equal(handle.getLevel(), 'medium');
  assert.ok(notes.some(n => n.includes('caps autonomy at "medium"')));

  // Synthetic before_agent_start without systemPromptOptions must not throw
  for (const fn of handlers.get('before_agent_start') ?? []) {
    await fn({ type: 'before_agent_start', messageType: 'user' }, ctx);
  }
});

test('autonomy prompt section tells planners what not to request and when it applies', async () => {
  const { autonomyPromptSection } = await import('./autonomy.ts');
  assert.equal(autonomyPromptSection('off', { planning: false, workflow: false, executing: false }), undefined);
  const spec = autonomyPromptSection('medium', { planning: true, workflow: true, executing: false });
  assert.match(spec, /Once the plan is approved/);
  assert.match(spec, /Do not request these in pi_safe_plan/);
  assert.match(spec, /pytest/);
  assert.match(autonomyPromptSection('low', { planning: false, workflow: true, executing: false }), /only after the plan is approved/);
  assert.match(autonomyPromptSection('low', { planning: false, workflow: false, executing: false }), /^Autonomy level is low.*They run without approval/s);
});

test('worktree subagents use the Auto Medium list, so bare scripts and in-place edits are not auto-run', async () => {
  const { autonomyAllowsShell } = await import('./autonomy.ts');
  const { loadEditPolicy } = await import('./approvals.ts');
  const policy = loadEditPolicy(new URL('..', import.meta.url).pathname);
  assert.equal(autonomyAllowsShell('medium', 'pytest -q', policy), 'auto-medium-dev');
  assert.equal(autonomyAllowsShell('medium', 'rg TODO src', policy), 'auto-low-readonly');
  for (const cmd of ['python3 evil.py', 'python3 -c print(1)', 'sed -i s/a/b/ file.py', 'mkdir out', 'touch x']) {
    assert.equal(autonomyAllowsShell('medium', cmd, policy), null, cmd);
  }
});
