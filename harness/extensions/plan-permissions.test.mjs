import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadEditPolicy } from './approvals.ts';
import {
  classifyPlanPermissions,
  extractPlanPermissions,
  normalizePlanSteps,
  planToolName,
  registerPlanPermissions,
} from './plan-permissions.ts';
import { registerShellApprovals } from './shell-approvals.ts';

const policy = loadEditPolicy(path.resolve(import.meta.dirname, '..'));

function makeWorkspace(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-plan-perms-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  const install = path.join(base, 'install');
  mkdirSync(path.join(cwd, 'src'), { recursive: true });
  mkdirSync(install, { recursive: true });
  writeFileSync(path.join(cwd, 'AGENTS.md'), '# Agents\n');
  writeFileSync(path.join(cwd, '.env'), 'SECRET=1\n');
  symlinkSync(path.join(cwd, 'AGENTS.md'), path.join(cwd, 'linked-agents.md'));
  return { base, cwd, install };
}

test('classifyPlanPermissions allows valid shell/file grants and rejects blocked commands, neverSessionAllow prefixes, secrets, and symlinks', t => {
  const { cwd } = makeWorkspace(t);

  const classified = classifyPlanPermissions(
    {
      shellPrefixes: [
        'node --test',
        'python3 -m pytest',
        'bash',
        'rm',
        'find',
        'FOO=1 pytest',
        'pytest && echo hi',
        'git push',
      ],
      shellCommands: [
        'ls -la',
        'rm -f dist/old.js',
        'python3 scripts/gen.py | head -n 5',
        'sudo reboot',
        'rm -rf build',
        'git commit -m "x"',
        `echo ${'a'.repeat(1250)}`,
      ],
      files: [
        'src/index.ts',
        'AGENTS.md',
        'package-lock.json',
        '.github/workflows/ci.yml',
        '.env',
        '.git/config',
        '../escape.txt',
        'linked-agents.md',
      ],
    },
    {
      cwd,
      policy,
      writeSubMode: 'ask-edits',
      isWritable: true,
    },
  );

  assert.deepEqual(classified.shellPrefixes, [
    ['node', '--test'],
    ['python3', '-m', 'pytest'],
  ]);
  assert.deepEqual(classified.shellCommands, [
    'rm -f dist/old.js',
    'python3 scripts/gen.py | head -n 5',
  ]);
  assert.deepEqual(classified.askFiles, [
    'AGENTS.md',
    'package-lock.json',
    '.github/workflows/ci.yml',
  ]);
  assert.deepEqual(classified.plannedFiles, ['src/index.ts']);
  assert.deepEqual(classified.deferredSymlinks, ['linked-agents.md']);
  assert.ok(classified.alreadyAllowed.some(item => item.includes('"ls -la"')));

  const rejectedValues = classified.rejected.map(r => r.value);
  for (const bad of ['bash', 'rm', 'find', 'FOO=1 pytest', 'pytest && echo hi', 'git push', 'sudo reboot', 'rm -rf build', 'git commit -m "x"', '.env', '.git/config', '../escape.txt']) {
    assert.ok(rejectedValues.includes(bad), `expected ${bad} to be rejected`);
  }
});

test('extractPlanPermissions parses markdown Permissions sections and ignores empty declarations', () => {
  const md = `
Plan:
1. Update parser implementation
2. Document behavior in AGENTS.md
3. Run tests

Permissions needed:
- prefix: \`node --test\`
- command: \`python3 scripts/verify.py\`
- files: \`AGENTS.md\`, \`src/parser.ts\`
`;
  assert.deepEqual(extractPlanPermissions(md), {
    shellPrefixes: ['node --test'],
    shellCommands: ['python3 scripts/verify.py'],
    files: ['AGENTS.md', 'src/parser.ts'],
  });

  const noneMd = `Plan:\n1. Read code\n\nPermissions:\n- none\n`;
  assert.equal(extractPlanPermissions(noneMd), undefined);
});

test('adaptive pi_safe_plan scopes grants to active plan, blocks mid-plan symlink swaps, persists shell rules on opt-in, and clears on finish', async t => {
  const { cwd, install } = makeWorkspace(t);
  const oldCwd = process.cwd();
  let planMode = 'normal';
  let writeSubMode = 'ask-edits';
  let planning = false;
  let startedSteps = [];
  let registeredTool = null;
  const hooks = new Map();
  const commands = new Map();
  const audits = [];
  let store;

  try {
    process.chdir(cwd);
    const pi = {
      registerTool(def) {
        registeredTool = def;
      },
      registerCommand(name, cmd) {
        commands.set(name, cmd.handler);
      },
      on(event, fn) {
        const list = hooks.get(event) ?? [];
        list.push(fn);
        hooks.set(event, list);
      },
    };
    let handleRef;
    store = registerShellApprovals(pi, install, {
      getPolicy: () => policy,
      getMode: () => writeSubMode,
      getPlanGrant: () => handleRef?.describeActiveGrant(),
      clearPlanGrant: () => handleRef?.clearGrant('manual') ?? false,
    });
    const handle = handleRef = registerPlanPermissions(pi, {
      getPolicy: () => policy,
      getWriteSubMode: () => writeSubMode,
      isWritable: () => !planning,
      isPlanning: () => planning,
      getPlanMode: () => planMode,
      startPlanExecution: steps => {
        planMode = 'execute';
        startedSteps = steps;
      },
      setPlannedStepsInPlanMode: steps => {
        startedSteps = steps;
      },
      getShellStore: () => store,
      onAudit: evt => audits.push(evt),
    });

    assert.equal(registeredTool.name, planToolName);
    assert.deepEqual(normalizePlanSteps(['1. First valid step', 'x', '2) Second valid step']), [
      { step: 1, text: 'First valid step', completed: false },
      { step: 2, text: 'Second valid step', completed: false },
    ]);

    // System prompt injection in interactive mode
    const sysEvt = { systemPromptOptions: { sections: {} } };
    for (const fn of hooks.get('before_agent_start')) {
      await fn(sysEvt, { cwd, hasUI: true });
    }
    assert.match(sysEvt.systemPromptOptions.sections.plan_permissions, /pi_safe_plan/);

    // 1. User rejects plan -> no grant, stays in normal mode
    const cancelCtx = {
      cwd,
      hasUI: true,
      ui: {
        notify() {},
        select: async () => 'Reject the plan',
      },
    };
    const cancelRes = await registeredTool.execute(
      'c1',
      {
        summary: 'Test cancel',
        steps: ['Update src/app.ts', 'Run tests'],
        permissions: { shellPrefixes: ['node --test'], files: ['src/app.ts'] },
      },
      undefined,
      undefined,
      cancelCtx,
    );
    assert.match(cancelRes.content[0].text, /The user rejected this plan/);
    assert.match(cancelRes.content[0].text, /Do NOT execute/);
    assert.equal(handle.hasActiveGrant(), false);
    assert.equal(planMode, 'normal');

    // 2. User approves plan for this plan only -> scoped grants active!
    let seenPrompt = '';
    const approveCtx = {
      cwd,
      hasUI: true,
      ui: {
        notify() {},
        select: async title => {
          seenPrompt = title;
          return 'Approve plan & permissions for this plan';
        },
      },
    };
    const okRes = await registeredTool.execute(
      'c2',
      {
        summary: 'Implement parser & docs',
        steps: ['Implement src/app.ts', 'Update AGENTS.md', 'Run node --test'],
        permissions: {
          shellPrefixes: ['node --test', 'bash'],
          shellCommands: ['rm -f tmp/stale.txt', 'git push origin main'],
          files: ['src/app.ts', 'AGENTS.md', '.env'],
        },
      },
      undefined,
      undefined,
      approveCtx,
    );
    assert.match(seenPrompt, /node --test/);
    assert.match(seenPrompt, /Blocked by policy/);
    assert.match(okRes.content[0].text, /Plan approved for execution/);
    assert.equal(planMode, 'execute');
    assert.equal(startedSteps.length, 3);
    assert.equal(handle.hasActiveGrant(), true);

    // Allowed by plan grant:
    assert.equal(handle.allowsShell('node --test src/app.test.mjs', policy.neverSessionAllow), 'plan-approved-prefix');
    assert.equal(handle.allowsShell('rm -f tmp/stale.txt', policy.neverSessionAllow), 'plan-approved-exact');
    assert.equal(handle.allowsFileEdit(cwd, 'AGENTS.md', 'ask', 'ask-edits'), 'plan-approved-sensitive-path');
    assert.equal(handle.allowsFileEdit(cwd, 'src/app.ts', 'allow', 'ask-edits'), 'plan-approved-edit');

    // NOT allowed by plan grant (unlisted or shell metacharacters or rejected):
    assert.equal(handle.allowsShell('node --test && echo pwn', policy.neverSessionAllow), null);
    assert.equal(handle.allowsShell('bash -c "echo no"', policy.neverSessionAllow), null);
    assert.equal(handle.allowsShell('rm -f other.txt', policy.neverSessionAllow), null);
    assert.equal(handle.allowsFileEdit(cwd, 'src/unlisted.ts', 'allow', 'ask-edits'), null);
    assert.equal(handle.allowsFileEdit(cwd, 'package-lock.json', 'ask', 'ask-edits'), null);

    // Project shell store was NOT written when choosing plan-only approval:
    assert.equal(store.allows('rm -f tmp/stale.txt'), false);
    assert.equal(store.allowsPrefix('node --test src/app.test.mjs', policy.neverSessionAllow), false);

    // /permissions shows active plan permissions and `/permissions clear-plan` revokes them on demand:
    const notices = [];
    await commands.get('permissions')('', { cwd, ui: { notify: msg => notices.push(msg) } });
    assert.match(notices.at(-1), /Active plan permissions.*node --test/s);

    // Mid-plan symlink swap defense: if src/app.ts becomes a symlink, plan grant refuses it!
    symlinkSync(path.join(cwd, 'AGENTS.md'), path.join(cwd, 'src/app.ts'));
    assert.equal(handle.allowsFileEdit(cwd, 'src/app.ts', 'allow', 'ask-edits'), null);

    // Clearing on plan completion drops all grants immediately:
    handle.clearGrant('complete');
    assert.equal(handle.hasActiveGrant(), false);
    assert.equal(handle.allowsShell('rm -f tmp/stale.txt', policy.neverSessionAllow), null);
    assert.equal(handle.allowsFileEdit(cwd, 'AGENTS.md', 'ask', 'ask-edits'), null);

    // 3. Explicit /plan mode: pi_safe_plan records proposal read-only, then confirmFromPlanMode saves shell rules on opt-in
    planning = true;
    planMode = 'plan';
    writeSubMode = 'accept-edits';
    const recordRes = await registeredTool.execute(
      'c3',
      {
        summary: 'Plan mode proposal',
        steps: ['Update AGENTS.md', 'Run python3 -m unittest'],
        permissions: {
          shellPrefixes: ['python3 -m unittest'],
          shellCommands: ['echo plan-saved'],
          files: ['AGENTS.md'],
        },
      },
      undefined,
      undefined,
      approveCtx,
    );
    assert.match(recordRes.content[0].text, /recorded for user review/);
    assert.equal(handle.hasActiveGrant(), false);

    planning = false;
    const planDecision = await handle.confirmFromPlanMode(
      {
        cwd,
        hasUI: true,
        ui: {
          notify() {},
          select: async () => 'Approve plan & save shell rules for this project',
        },
      },
      startedSteps,
      '',
    );
    assert.equal(planDecision, 'execute');
    assert.equal(handle.hasActiveGrant(), true);
    assert.equal(store.allows('echo plan-saved'), true);
    assert.equal(store.allowsPrefix('python3 -m unittest discover', policy.neverSessionAllow), true);
    assert.equal(handle.allowsFileEdit(cwd, 'AGENTS.md', 'ask', 'accept-edits'), 'plan-approved-sensitive-path');

    // Manual /permissions clear-plan clears the active plan grant while keeping project-saved shell rules
    await commands.get('permissions')('clear-plan', { cwd, ui: { notify: msg => notices.push(msg) } });
    assert.match(notices.at(-1), /Cleared active plan permissions/);
    assert.equal(handle.hasActiveGrant(), false);
    assert.equal(handle.allowsFileEdit(cwd, 'AGENTS.md', 'ask', 'accept-edits'), null);
    assert.equal(store.allows('echo plan-saved'), true);

    assert.ok(audits.some(a => a.rule === 'plan-rejected' && a.decision === 'denied'));
    assert.ok(audits.some(a => a.rule === 'plan-approved' && a.decision === 'approved'));
    assert.ok(audits.some(a => a.rule === 'plan-proposal-recorded' && a.decision === 'allow'));
    assert.ok(audits.some(a => a.rule === 'plan-approved-saved-shell' && a.decision === 'approved'));
  } finally {
    process.chdir(oldCwd);
  }
});

test('plan approval offers Auto Medium upgrade and invokes onPlanApproved hook', async t => {
  const { cwd } = makeWorkspace(t);
  let registeredTool;
  let autoLevel = 'off';
  const approvedHooks = [];
  const fakePi = {
    registerTool(def) { registeredTool = def; },
    on() {},
  };

  registerPlanPermissions(fakePi, {
    getPolicy: () => policy,
    getWriteSubMode: () => 'ask-edits',
    getAutonomyLevel: () => autoLevel,
    setAutonomyLevel: next => { autoLevel = next; },
    isWritable: () => true,
    isPlanning: () => false,
    getPlanMode: () => 'normal',
    startPlanExecution() {},
    setPlannedStepsInPlanMode() {},
    getShellStore: () => undefined,
    onPlanApproved: info => approvedHooks.push(info),
  });

  const res = await registeredTool.execute(
    'am1',
    {
      summary: 'Upgrade autonomy on spec approval',
      steps: ['Edit src/feature.ts', 'Run pytest'],
      permissions: { files: ['AGENTS.md'] },
    },
    undefined,
    undefined,
    {
      cwd,
      hasUI: true,
      ui: {
        notify() {},
        select: async (_title, choices) => {
          assert.ok(choices.includes('Approve plan & enable Auto Medium (dev/test commands)'));
          return 'Approve plan & enable Auto Medium (dev/test commands)';
        },
      },
    },
  );
  assert.match(res.content[0].text, /Plan approved for execution/);
  assert.equal(autoLevel, 'medium');
  assert.equal(approvedHooks.length, 1);
  assert.equal(approvedHooks[0].summary, 'Upgrade autonomy on spec approval');
});

test('workflow mode enforces default-reject options, tracks rejected execution commands, supports interactive subset approval, and honors retroactive deny rules', async t => {
  const { cwd, install } = makeWorkspace(t);
  const oldCwd = process.cwd();
  let planMode = 'normal';
  let writeSubMode = 'workflow';
  let registeredTool = null;
  const hooks = new Map();
  const commands = new Map();
  const audits = [];
  let rejectedUpdates = 0;

  try {
    process.chdir(cwd);
    const pi = {
      registerTool(def) { registeredTool = def; },
      registerCommand(name, cmd) { commands.set(name, cmd.handler); },
      on(event, fn) {
        const list = hooks.get(event) ?? [];
        list.push(fn);
        hooks.set(event, list);
      },
    };
    let handleRef;
    const store = registerShellApprovals(pi, install, {
      getPolicy: () => policy,
      getMode: () => writeSubMode,
      getPlanGrant: () => handleRef?.describeActiveGrant(),
      clearPlanGrant: () => handleRef?.clearGrant('manual') ?? false,
      getRejectedSummary: c => handleRef?.formatRejectedSummaryForPermissions(c),
      handleRejectedSubcommand: (sub, c) => handleRef.handleRejectedCommand(sub, c),
    });
    const handle = handleRef = registerPlanPermissions(pi, {
      getPolicy: () => policy,
      getWriteSubMode: () => writeSubMode,
      isWritable: () => true,
      isPlanning: () => false,
      getPlanMode: () => planMode,
      startPlanExecution: () => { planMode = 'execute'; },
      setPlannedStepsInPlanMode: () => {},
      getShellStore: () => store,
      onRejectedChange: () => { rejectedUpdates++; },
      onAudit: evt => audits.push(evt),
    });

    // Stage 1 system prompt describes strict 3-stage workflow
    const stage1Evt = { systemPromptOptions: { sections: {} } };
    for (const fn of hooks.get('before_agent_start')) {
      await fn(stage1Evt, { cwd, hasUI: true });
    }
    assert.match(stage1Evt.systemPromptOptions.sections.plan_permissions, /Stage 1 — Plan/);
    assert.match(stage1Evt.systemPromptOptions.sections.plan_permissions, /Stage 2 — Ask for Permissions/);
    assert.match(stage1Evt.systemPromptOptions.sections.plan_permissions, /rejected by default/);

    // Stage 2 approval dialog in workflow mode replaces "ask for each permission individually" with "reject unapproved commands"
    let dialogTitle = '';
    let dialogChoices = [];
    const planRes = await registeredTool.execute(
      'wf1',
      {
        summary: 'Workflow execution test',
        steps: ['Edit src/index.ts', 'Run approved command'],
        permissions: {
          shellCommands: ['echo upfront-ok', 'git diff --check -- README.md'],
          files: ['src/index.ts'],
          worktreeSubagents: true,
        },
      },
      undefined,
      undefined,
      {
        cwd,
        hasUI: true,
        ui: {
          notify() {},
          select: async (title, choices) => {
            dialogTitle = title;
            dialogChoices = choices;
            return 'Approve plan & permissions for this plan';
          },
        },
      },
    );
    assert.match(dialogTitle, /Planned edits \(workflow mode, 1\): "src\/index\.ts"/);
    assert.ok(dialogChoices.includes('Execute plan without extra permissions (reject unapproved commands)'));
    assert.ok(!dialogChoices.includes('Execute plan (ask for each permission individually)'));
    assert.match(planRes.content[0].text, /Approved planned file edits for this plan: src\/index\.ts/);
    assert.match(planRes.content[0].text, /\.git is masked as empty inside pi_safe_bash; use the pi_safe_git tool/);
    assert.match(planRes.content[0].text, /rejected by default/);
    assert.equal(planMode, 'execute');
    assert.equal(handle.allowsFileEdit(cwd, 'src/index.ts', 'allow', 'workflow'), 'plan-approved-edit');
    assert.equal(handle.allowsFileEdit(cwd, 'src/unplanned.ts', 'allow', 'workflow'), null);
    assert.equal(handle.allowsWorktreeDelegate(cwd), 'plan-approved-worktree');

    // Record rejected items during Stage 3 execution (with deduplication on repeated command)
    const notices = [];
    const uiCtx = { cwd, hasUI: true, ui: { notify: msg => notices.push(msg) } };
    const r1 = handle.recordRejectedShell({ cwd, command: 'pytest tests/test_slow.py', tool: 'pi_safe_bash', ctx: uiCtx });
    const r1Dup = handle.recordRejectedShell({ cwd, command: 'pytest tests/test_slow.py', tool: 'pi_safe_bash', ctx: uiCtx });
    const r2 = handle.recordRejectedShell({ cwd, command: 'rm -f tmp/cache.db', tool: 'pi_safe_bash', ctx: uiCtx });
    const r3 = handle.recordRejectedFile({ cwd, filePath: 'AGENTS.md', decision: 'ask', tool: 'pi_safe_write', ctx: uiCtx });

    assert.equal(r1.id, 1);
    assert.equal(r1Dup.id, 1);
    assert.equal(r1Dup.count, 2);
    assert.equal(r2.id, 2);
    assert.equal(r2.suggestedPrefix, undefined); // `rm` is in neverSessionAllow!
    assert.equal(r3.id, 3);
    assert.equal(handle.pendingRejectedCount(cwd), 3);
    assert.equal(handle.consumeTurnRejectionPause(), true);
    assert.equal(handle.consumeTurnRejectionPause(), false);

    // Clearing the plan grant on completion MUST NOT wipe the rejected execution queue!
    handle.clearGrant('complete');
    assert.equal(handle.hasActiveGrant(), false);
    assert.equal(handle.pendingRejectedCount(cwd), 3);

    // /permissions shows the rejected items summary
    await commands.get('permissions')('', uiCtx);
    assert.match(notices.at(-1), /Rejected during execution \(3 pending, 0 approved\)/);

    // Interactive /rejected: select ONLY #1 and approve with safe prefix -> #2 and #3 remain rejected!
    let step = 0;
    await commands.get('rejected')('', {
      cwd,
      hasUI: true,
      ui: {
        notify: msg => notices.push(msg),
        select: async (_title, choices) => {
          step++;
          if (step === 1) {
            return choices.find(c => c.includes('#1 Command:'));
          }
          return choices.find(c => c.startsWith('✓ Approve selected (1) with script grants / safe prefixes'));
        },
      },
    });

    assert.equal(handle.pendingRejectedCount(cwd), 2);
    assert.equal(handle.allowsShell('pytest tests/test_fast.py', policy.neverSessionAllow), 'rejected-approved-prefix');
    assert.equal(handle.allowsApprovedRejectedShell('pytest tests/test_fast.py', policy.neverSessionAllow), 'rejected-approved-prefix');
    assert.equal(handle.allowsShell('rm -f tmp/cache.db', policy.neverSessionAllow), null);
    assert.equal(handle.allowsApprovedRejectedFile(cwd, 'AGENTS.md', 'ask'), null);

    // Approve #2 via /permissions approve-rejected 2 --save -> persists exact rule to store
    await commands.get('permissions')('approve-rejected 2 --save', uiCtx);
    assert.equal(store.allows('rm -f tmp/cache.db'), true);
    assert.equal(handle.allowsApprovedRejectedShell('rm -f tmp/cache.db', policy.neverSessionAllow), 'rejected-approved-exact');
    assert.equal(handle.pendingRejectedCount(cwd), 1);

    // Retroactive /permissions deny rule MUST override even a previously approved rejected prefix!
    await commands.get('permissions')('deny pytest', uiCtx);
    assert.equal(handle.allowsShell('pytest tests/test_fast.py', policy.neverSessionAllow), null);
    assert.equal(handle.allowsApprovedRejectedShell('pytest tests/test_fast.py', policy.neverSessionAllow), null);

    // Approve #3 (AGENTS.md), then verify mid-session symlink swap blocks it
    await commands.get('rejected')('approve 3', uiCtx);
    assert.equal(handle.allowsApprovedRejectedFile(cwd, 'AGENTS.md', 'ask'), 'rejected-approved-sensitive-path');
    rmSync(path.join(cwd, 'AGENTS.md'));
    symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'AGENTS.md'));
    assert.equal(handle.allowsApprovedRejectedFile(cwd, 'AGENTS.md', 'ask'), null);

    // /rejected clear resets rejected queue & session rejected grants
    await commands.get('rejected')('clear', uiCtx);
    assert.equal(handle.listRejected(cwd).length, 0);
    assert.equal(handle.allowsApprovedRejectedShell('rm -f tmp/cache.db', policy.neverSessionAllow), null);
    assert.ok(rejectedUpdates >= 4);
    assert.ok(audits.some(a => a.rule === 'rejected-exec-session-prefix' && a.decision === 'approved'));
    assert.ok(audits.some(a => a.rule === 'rejected-exec-project-exact' && a.decision === 'approved'));
  } finally {
    process.chdir(oldCwd);
  }
});

test('normalizePlanSteps preserves 140-240 char steps untruncated and caps >240 char steps at 240', () => {
  const longValid = 'Create the 2026-11-23 daily research memo for assumption challenge AC-04, cross-checking prior regime tables and recording reproducibility notes in docs/work-log.md';
  assert.ok(longValid.length > 140 && longValid.length <= 240);
  const tooLong = `Step ${'a'.repeat(260)}`;
  const normalized = normalizePlanSteps([`1. ${longValid}`, tooLong]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].text, longValid);
  assert.equal(normalized[1].text.length, 240);
  assert.ok(normalized[1].text.endsWith('...'));
});

test('openFiles permissions work in writable and read-only workspaces, support /rejected approval, and block secrets/symlinks', async t => {
  const { cwd } = makeWorkspace(t);
  const oldCwd = process.cwd();
  let planMode = 'normal';
  let registeredTool = null;
  const commands = new Map();

  try {
    process.chdir(cwd);
    // 1. Markdown extraction & read-only classification
    const parsed = extractPlanPermissions(
      'Plan:\n1. Open deck\n\nPermissions:\n- open: `decks/pitch.pptx`, `reports/summary.pdf`\n',
    );
    assert.deepEqual(parsed, { openFiles: ['decks/pitch.pptx', 'reports/summary.pdf'] });

    const classifiedReadOnly = classifyPlanPermissions(
      {
        openFiles: ['decks/pitch.pptx', '.env', 'linked-agents.md', 'src/run.sh', '../outside.pdf'],
      },
      { cwd, policy, writeSubMode: 'workflow', isWritable: false },
    );
    assert.deepEqual(classifiedReadOnly.openFiles, ['decks/pitch.pptx']);
    const rejOpen = classifiedReadOnly.rejected.map(r => r.value);
    for (const bad of ['.env', 'linked-agents.md', 'src/run.sh', '../outside.pdf']) {
      assert.ok(rejOpen.includes(bad), `expected ${bad} to be rejected for openFiles`);
    }

    // 2. Plan grant + /rejected approval for openFiles
    const pi = {
      registerTool(def) { registeredTool = def; },
      registerCommand(name, cmd) { commands.set(name, cmd.handler); },
      on() {},
    };
    const handle = registerPlanPermissions(pi, {
      getPolicy: () => policy,
      getWriteSubMode: () => 'workflow',
      isWritable: () => false,
      isPlanning: () => false,
      getPlanMode: () => planMode,
      startPlanExecution: () => { planMode = 'execute'; },
      setPlannedStepsInPlanMode: () => {},
      getShellStore: () => undefined,
    });

    let dialogBody = '';
    await registeredTool.execute(
      'op1',
      {
        summary: 'Open existing pitch deck',
        steps: ['Open decks/pitch.pptx on host desktop'],
        permissions: { openFiles: ['decks/pitch.pptx'] },
      },
      undefined,
      undefined,
      {
        cwd,
        hasUI: true,
        ui: {
          notify() {},
          select: async title => {
            dialogBody = title;
            return 'Approve plan & permissions for this plan';
          },
        },
      },
    );
    assert.match(dialogBody, /Open on host desktop \(1\): "decks\/pitch\.pptx"/);
    assert.equal(handle.allowsFileOpen(cwd, 'decks/pitch.pptx'), 'plan-approved-open');
    assert.equal(handle.allowsFileOpen(cwd, 'decks/other.pptx'), null);

    // Unrequested open during execution enters /rejected and can be approved
    const uiCtx = { cwd, hasUI: true, ui: { notify() {} } };
    const rej = handle.recordRejectedOpen({ cwd, filePath: 'decks/extra.pdf', tool: 'pi_safe_open', ctx: uiCtx });
    assert.equal(rej.id, 1);
    assert.equal(rej.kind, 'open');
    await commands.get('rejected')('approve 1', uiCtx);
    assert.equal(handle.allowsApprovedRejectedOpen(cwd, 'decks/extra.pdf'), 'rejected-approved-open');

    // Symlink swap on approved open target revokes access immediately
    mkdirSync(path.join(cwd, 'decks'), { recursive: true });
    symlinkSync(path.join(cwd, '.env'), path.join(cwd, 'decks/extra.pdf'));
    assert.equal(handle.allowsApprovedRejectedOpen(cwd, 'decks/extra.pdf'), null);
  } finally {
    process.chdir(oldCwd);
  }
});

test('workflow script grants cover any arguments until the script or a local import changes, then reject into /rejected with a re-pin option', async t => {
  const { cwd, install } = makeWorkspace(t);
  mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  writeFileSync(path.join(cwd, 'scripts', 'backtest.py'), 'import lib\nprint(lib.X)\n');
  writeFileSync(path.join(cwd, 'scripts', 'lib.py'), 'X = 1\n');
  const oldCwd = process.cwd();
  let planMode = 'normal';
  let resumed = 0;
  let registeredTool = null;
  const hooks = new Map();
  const commands = new Map();
  try {
    process.chdir(cwd);
    const pi = {
      registerTool(def) { registeredTool = def; },
      registerCommand(name, cmd) { commands.set(name, cmd.handler); },
      on(event, fn) { hooks.set(event, [...(hooks.get(event) ?? []), fn]); },
    };
    const store = registerShellApprovals(pi, install, { getPolicy: () => policy });
    const handle = registerPlanPermissions(pi, {
      getPolicy: () => policy,
      getWriteSubMode: () => 'workflow',
      getAutonomyLevel: () => 'medium',
      isWritable: () => true,
      isPlanning: () => false,
      getPlanMode: () => planMode,
      startPlanExecution: () => { planMode = 'execute'; },
      setPlannedStepsInPlanMode: () => {},
      getShellStore: () => store,
      onResumeAfterApproval: () => { resumed++; },
    });

    // Autonomy-covered items are listed as already allowed, not as grants.
    const classified = classifyPlanPermissions(
      { scripts: ['python3 scripts/backtest.py', 'python3 scripts/missing.py', 'bash run.sh'], shellCommands: ['pytest -q', 'python3 scripts/backtest.py --year 2020'], files: ['src/a.py'] },
      { cwd, policy, writeSubMode: 'workflow', autonomyLevel: 'medium', isWritable: true, store },
    );
    assert.equal(classified.scripts.length, 1);
    assert.deepEqual(classified.scripts[0].files, ['scripts/backtest.py', 'scripts/lib.py']);
    assert.deepEqual(classified.shellCommands, [], 'script runs are covered by the script grant, pytest by Auto Medium');
    assert.deepEqual(classified.plannedFiles, [], 'normal edits are covered by Auto Medium in workflow execution too');
    assert.ok(classified.alreadyAllowed.some(a => a.includes('pytest -q') && a.includes('auto-medium')));
    assert.deepEqual(classified.rejected.map(r => r.value), ['python3 scripts/missing.py', 'bash run.sh']);

    let dialog = '';
    await registeredTool.execute('s1', {
      summary: 'Backtest',
      steps: ['Run the backtest for several years'],
      permissions: { scripts: ['python3 scripts/backtest.py'] },
    }, undefined, undefined, {
      cwd, hasUI: true,
      ui: { notify() {}, select: async (title, choices) => { dialog = title; return choices[0]; } },
    });
    assert.match(dialog, /Script, any arguments while unchanged: "python3 scripts\/backtest\.py … \(\+1 local module\)"/);
    assert.equal(handle.allowsShell('python3 scripts/backtest.py --year 2019', policy.neverSessionAllow), 'plan-approved-script');
    assert.equal(handle.allowsShell('python3 scripts/backtest.py --year 2020 --tickers AAPL,MSFT', policy.neverSessionAllow), 'plan-approved-script');

    // The agent edits a local module the script imports: the grant no longer matches.
    writeFileSync(path.join(cwd, 'scripts', 'lib.py'), 'import os\nX = os.getcwd()\n');
    assert.equal(handle.allowsShell('python3 scripts/backtest.py --year 2021', policy.neverSessionAllow), null);
    const notices = [];
    const entry = handle.recordRejectedShell({ cwd, command: 'python3 scripts/backtest.py --year 2021', tool: 'pi_safe_bash', ctx: { hasUI: true, ui: { notify: m => notices.push(m) } } });
    assert.equal(entry.scriptChanged, true);
    assert.equal(entry.suggestedScript, 'python3 scripts/backtest.py');
    assert.match(notices.at(-1), /Rejected changed script/);

    // The pause dialog puts "keep paused" first; approving as script grants re-pins and resumes.
    let pauseChoices = [];
    await handle.promptAfterRejectionPause({
      cwd, hasUI: true, mode: 'tui', isIdle: () => true,
      ui: { notify() {}, select: async (title, choices) => { pauseChoices = choices; assert.match(title, /changed script/); return choices.find(c => c.includes('script grants')); } },
    });
    assert.equal(pauseChoices[0], 'Keep paused (review later with /rejected)');
    assert.equal(resumed, 1);
    assert.equal(handle.pendingRejectedCount(cwd), 0);
    assert.equal(handle.allowsShell('python3 scripts/backtest.py --year 2022', policy.neverSessionAllow), 'plan-approved-script'.replace('plan', 'rejected'));

    // Keep paused does nothing.
    handle.recordRejectedShell({ cwd, command: 'make deploy', tool: 'pi_safe_bash' });
    await handle.promptAfterRejectionPause({
      cwd, hasUI: true, mode: 'tui', isIdle: () => true,
      ui: { notify() {}, select: async choices => 'Keep paused (review later with /rejected)' },
    });
    assert.equal(handle.pendingRejectedCount(cwd), 1);
    assert.equal(resumed, 1);
  } finally {
    process.chdir(oldCwd);
  }
});

test('saved script rules match at the approved content, re-pin on re-approval, and show in /permissions', async t => {
  const { cwd, install } = makeWorkspace(t);
  writeFileSync(path.join(cwd, 'report.py'), 'print(1)\n');
  const oldCwd = process.cwd();
  const commands = new Map();
  try {
    process.chdir(cwd);
    const store = registerShellApprovals({ registerCommand(name, cmd) { commands.set(name, cmd.handler); } }, install, { getPolicy: () => policy, getMode: () => 'accept-edits' });
    assert.equal(store.scriptStatus('python3 report.py --out a', policy), 'none');
    store.addScript('python3 report.py', policy);
    assert.equal(store.allowsScript('python3 report.py --out a', policy), true);
    assert.equal(store.evaluate('python3 report.py --out b', policy).kind, 'saved-script');
    writeFileSync(path.join(cwd, 'report.py'), 'print(2)\n');
    assert.equal(store.scriptStatus('python3 report.py', policy), 'changed');
    store.addScript('python3 report.py', policy);
    assert.equal(store.scriptStatus('python3 report.py', policy), 'match');
    assert.equal(store.scriptGrants().length, 1, 're-approval replaces the old rule');
    const classified = classifyPlanPermissions({ shellCommands: ['python3 report.py --out c'] },
      { cwd, policy, writeSubMode: 'accept-edits', isWritable: true, store });
    assert.deepEqual(classified.shellCommands, []);
    assert.ok(classified.alreadyAllowed.some(a => a.includes('saved script')));
    const notes = [];
    commands.get('permissions')('', { cwd, ui: { notify: m => notes.push(m) } });
    assert.match(notes.at(-1), /Saved script rules .*\(1\):\n\s+\w+\s+"python3 report\.py …" \(unchanged\)/);
    assert.throws(() => store.addScript('python3 missing.py', policy), /cannot be saved/);
    // A fingerprint pinned when the prompt was shown wins over content changed while it was open.
    const { makeScriptGrant } = await import('./script-grants.ts');
    const shown = makeScriptGrant('python3 report.py', cwd, policy);
    writeFileSync(path.join(cwd, 'report.py'), 'print("swapped while the prompt was open")\n');
    store.addScript('python3 report.py', policy, shown);
    assert.equal(store.scriptStatus('python3 report.py', policy), 'changed');
  } finally {
    process.chdir(oldCwd);
  }
});

test('never-auto scripts cannot be granted upfront in any permission field', t => {
  const { cwd } = makeWorkspace(t);
  mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  writeFileSync(path.join(cwd, 'scripts', 'c01s_broker.py'), 'print(1)\n');
  writeFileSync(path.join(cwd, 'scripts', 'backtest.py'), 'print(1)\n');
  const classified = classifyPlanPermissions(
    {
      scripts: ['python3 scripts/c01s_broker.py', 'python3 scripts/backtest.py'],
      shellCommands: ['python3 scripts/c01s_broker.py --live | tee log'],
      shellPrefixes: ['python3 -m scripts.c01s_broker'],
    },
    { cwd, policy, writeSubMode: 'workflow', isWritable: true, neverAuto: ['*broker*'] },
  );
  assert.deepEqual(classified.scripts.map(s => s.script), ['scripts/backtest.py']);
  assert.deepEqual(classified.shellCommands, []);
  assert.deepEqual(classified.shellPrefixes, []);
  assert.equal(classified.rejected.length, 3);
  assert.ok(classified.rejected.every(r => /never-auto pattern "\*broker\*"; it asks on every run/.test(r.reason)));
});

test('/permissions never-auto lists built-in globs and adds or removes project ones', t => {
  const { cwd, install } = makeWorkspace(t);
  const oldCwd = process.cwd();
  const commands = new Map();
  let project = [];
  try {
    process.chdir(cwd);
    registerShellApprovals({ registerCommand(name, cmd) { commands.set(name, cmd.handler); } }, install, {
      getPolicy: () => policy,
      getMode: () => 'workflow',
      neverAuto: {
        list: () => ({ builtIn: policy.neverAutoScripts ?? [], project }),
        update: (_cwd, glob, add) => { project = add ? [...new Set([...project, glob])] : project.filter(g => g !== glob); return project; },
      },
    });
    const notes = [];
    const ctx = { cwd, ui: { notify: m => notes.push(m) } };
    commands.get('permissions')('never-auto add *live_trad*', ctx);
    assert.deepEqual(project, ['*live_trad*']);
    assert.match(notes.at(-1), /Built-in \(write-guard\.json\): \*broker\*, ibkr\*, deploy\*\nThis project: \*live_trad\*/);
    commands.get('permissions')('', ctx);
    assert.match(notes.at(-1), /Never-auto scripts \(ask every run.*\*broker\*, ibkr\*, deploy\* \(built-in\), \*live_trad\* \(this project\)/);
    commands.get('permissions')('never-auto remove *live_trad*', ctx);
    assert.deepEqual(project, []);
  } finally {
    process.chdir(oldCwd);
  }
});

test('plan review has no timeout, re-shows on Esc, and reports revise, reject, interrupt and no-decision truthfully', async t => {
  const { cwd, install } = makeWorkspace(t);
  const oldCwd = process.cwd();
  let registeredTool = null;
  const audits = [];
  try {
    process.chdir(cwd);
    const pi = { registerTool(def) { registeredTool = def; }, registerCommand() {}, on() {} };
    const store = registerShellApprovals(pi, install, { getPolicy: () => policy, getMode: () => 'ask-edits' });
    let planMode = 'normal';
    const handle = registerPlanPermissions(pi, {
      getPolicy: () => policy, getWriteSubMode: () => 'ask-edits', isWritable: () => true, isPlanning: () => false,
      getPlanMode: () => planMode, startPlanExecution: () => { planMode = 'execute'; }, setPlannedStepsInPlanMode() {},
      getShellStore: () => store, onAudit: evt => audits.push(evt),
    });
    const params = { summary: 'Demo', steps: ['Update src/app.ts', 'Run tests'], permissions: { files: ['src/app.ts'] } };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const run = ui => registeredTool.execute('p', params, undefined, undefined, { cwd, hasUI: true, ui: { notify() {}, ...ui } });

    // Revise: Esc twice (slow, like a person) re-shows the review; an empty editor goes back to it; feedback returns.
    const selectOpts = [];
    let shown = 0;
    const editorAnswers = ['', '  Test the swing arm with lateral platens.  '];
    const revise = await run({
      select: async (_title, choices, opts) => {
        selectOpts.push(opts ?? {});
        shown++;
        if (shown <= 2) { await sleep(300); return undefined; }
        return choices.find(c => c.startsWith('Revise the plan'));
      },
      editor: async () => editorAnswers.shift(),
    });
    assert.equal(shown, 4, 'Esc and an empty revision both re-show the review');
    assert.ok(selectOpts.every(o => o.timeout === undefined), 'the review never times out');
    assert.match(revise.content[0].text, /asked for changes/);
    assert.match(revise.content[0].text, /Test the swing arm with lateral platens\./);
    assert.match(revise.content[0].text, new RegExp(`call ${planToolName} again`));
    assert.doesNotMatch(revise.content[0].text, /rejected/);
    assert.equal(planMode, 'normal');
    assert.equal(handle.hasActiveGrant(), false);

    // Interrupt: the agent turn is aborted while the review is open.
    const ac = new AbortController();
    const interrupted = await registeredTool.execute('p', params, undefined, undefined, {
      cwd, hasUI: true, signal: ac.signal,
      ui: { notify() {}, select: async () => { ac.abort(); return undefined; } },
    });
    assert.match(interrupted.content[0].text, /interrupted before the user decided/);
    assert.doesNotMatch(interrupted.content[0].text, /user rejected/);

    // A UI that closes the review instantly every time cannot loop forever.
    let instant = 0;
    const none = await run({ select: async () => { instant++; return undefined; } });
    assert.equal(instant, 3);
    assert.match(none.content[0].text, /could not be shown/);

    for (const rule of ['plan-revise', 'plan-interrupted', 'plan-no-decision']) {
      assert.ok(audits.some(a => a.rule === rule && a.decision === 'denied'), rule);
    }

    // Plan mode: revise hands over to pi-plan's editor ('refine'); reject and stay keep plan mode ('stay').
    const pick = label => ({ cwd, hasUI: true, ui: { notify() {}, select: async (_t, choices) => choices.find(c => c.startsWith(label)) } });
    const steps = normalizePlanSteps(['1. Update src/app.ts']);
    assert.equal(await handle.confirmFromPlanMode(pick('Revise the plan'), steps, ''), 'refine');
    assert.equal(await handle.confirmFromPlanMode(pick('Reject the plan'), steps, ''), 'stay');
    assert.equal(await handle.confirmFromPlanMode(pick('Stay in plan mode'), steps, ''), 'stay');
    assert.ok(audits.some(a => a.rule === 'plan-rejected' && a.args?.fromPlanMode));
  } finally {
    process.chdir(oldCwd);
  }
});
