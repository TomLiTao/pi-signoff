import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BUILTIN_DROIDS,
  parseDroidMarkdown,
  registerDroids,
  resolveDelegateExecution,
} from './droids.ts';

test('parseDroidMarkdown parses Factory Droid frontmatter, maps tool aliases, and blocks reserved/control inputs', () => {
  assert.deepEqual(BUILTIN_DROIDS.map(d => d.name), ['explorer', 'reviewer', 'worker']);

  const parsed = parseDroidMarkdown(
    `---
name: api-migrator
description: "Migrates REST handlers to typed schemas"
model: anthropic/claude-sonnet-4-5
reasoningEffort: high
tools: [Read, Grep, Glob, Edit, Create, Execute]
---
Inspect route handlers and migrate them cleanly.
`,
    'api-migrator',
    { source: 'user', trustStatus: 'user' },
  );

  assert.equal(parsed.name, 'api-migrator');
  assert.equal(parsed.model, 'anthropic/claude-sonnet-4-5');
  assert.equal(parsed.reasoningEffort, 'high');
  assert.equal(parsed.writeCapable, true);
  assert.deepEqual(parsed.tools, [
    'pi_safe_read',
    'pi_safe_grep',
    'pi_safe_find',
    'pi_safe_edit',
    'pi_safe_write',
    'pi_safe_bash',
  ]);

  // Reserved built-in name rejected
  assert.throws(
    () =>
      parseDroidMarkdown(
        `---\nname: explorer\n---\nShadow attempt\n`,
        'explorer',
        { source: 'project', trustStatus: 'untrusted' },
      ),
    /reserved by a built-in droid/,
  );

  // Flag-injection model string rejected
  assert.throws(
    () =>
      parseDroidMarkdown(
        `---\nname: bad-model\nmodel: --approve\n---\nPrompt\n`,
        'bad-model',
        { source: 'user', trustStatus: 'user' },
      ),
    /Invalid droid model/,
  );

  // Hidden control characters rejected
  assert.throws(
    () =>
      parseDroidMarkdown(
        `---\nname: bad-ctrl\n---\nHello \u202E world\n`,
        'bad-ctrl',
        { source: 'user', trustStatus: 'user' },
      ),
    /hidden or control/,
  );
});

test('resolveDelegateExecution enforces trust, session capability caps, plan-mode write blocks, and complexity tiers', () => {
  const untrusted = parseDroidMarkdown(
    `---\nname: proj-helper\ntools: read-only\n---\nHelp out.\n`,
    'proj-helper',
    { source: 'project', trustStatus: 'untrusted' },
  );
  assert.throws(
    () =>
      resolveDelegateExecution({
        task: 'Check files',
        droid: untrusted,
        parentProvider: 'openai',
        parentModel: 'gpt-5',
        parentThinking: 'low',
        activeParentTools: ['pi_safe_read'],
        webEnabled: false,
        fetchEnabled: false,
        gitEnabled: true,
        isPlanning: false,
        isWritable: true,
      }),
    /untrusted/,
  );

  const researchDroid = parseDroidMarkdown(
    `---\nname: web-helper\ntools: research\nreasoningEffort: medium\n---\nResearch docs.\n`,
    'web-helper',
    { source: 'user', trustStatus: 'user' },
  );
  const resolved = resolveDelegateExecution({
    task: 'Find auth docs',
    droid: researchDroid,
    complexity: 'heavy',
    parentProvider: 'openai',
    parentModel: 'gpt-5',
    parentThinking: 'low',
    activeParentTools: ['pi_safe_read'],
    webEnabled: false, // --no-web in parent must strip pi_safe_web_search!
    fetchEnabled: true,
    gitEnabled: false, // --no-git in parent must strip pi_safe_git!
    isPlanning: false,
    isWritable: true,
  });
  assert.equal(resolved.thinking, 'high');
  assert.equal(resolved.toolsCsv.includes('pi_safe_web_search'), false);
  assert.equal(resolved.toolsCsv.includes('pi_safe_git'), false);
  assert.equal(resolved.toolsCsv.includes('pi_safe_web_fetch'), true);

  // Worker droid blocked in plan mode
  const workerDroid = BUILTIN_DROIDS.find(d => d.name === 'worker');
  assert.throws(
    () =>
      resolveDelegateExecution({
        task: 'Edit code',
        droid: workerDroid,
        parentProvider: 'openai',
        parentModel: 'gpt-5',
        parentThinking: 'low',
        activeParentTools: ['pi_safe_read'],
        webEnabled: true,
        fetchEnabled: true,
        gitEnabled: true,
        isPlanning: true,
        isWritable: false,
      }),
    /unavailable while in plan\/read-only mode/,
  );
});

test('registerDroids auto-loads personal droids, requires SHA-256 pinning for .factory/droids, detects modifications, and creates droids', async t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-droids-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'repo');
  const installDir = path.join(base, 'install');
  const userDroids = path.join(base, 'user-droids');
  mkdirSync(path.join(cwd, '.factory', 'droids'), { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(userDroids, { recursive: true });

  writeFileSync(
    path.join(userDroids, 'my-auditor.md'),
    `---\nname: my-auditor\ndescription: Personal auditor\ntools: reviewer\n---\nAudit carefully.\n`,
    { mode: 0o600 },
  );

  const projFile = path.join(cwd, '.factory', 'droids', 'db-specialist.md');
  writeFileSync(
    projFile,
    `---\nname: db-specialist\ndescription: SQL schema reviewer\ntools: [Read, Grep]\n---\nCheck migrations.\n`,
  );
  // Symlinked droid must be ignored
  symlinkSync(projFile, path.join(cwd, '.factory', 'droids', 'linked-droid.md'));

  const oldCwd = process.cwd();
  process.chdir(cwd);
  try {
    const commands = new Map();
    const handlers = new Map();
    const fakePi = {
      registerCommand(name, def) { commands.set(name, def); },
      on(ev, fn) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
    };

    const handle = registerDroids(fakePi, {
      dir: installDir,
      secretPaths: ['.env', 'secrets.*'],
      userDroidsDir: userDroids,
    });

    // Initially: built-ins + personal active; project droid untrusted!
    const activeInitial = handle.listActive().map(d => d.name);
    assert.ok(activeInitial.includes('explorer'));
    assert.ok(activeInitial.includes('my-auditor'));
    assert.ok(!activeInitial.includes('db-specialist'));
    assert.equal(handle.getDroid('db-specialist').trustStatus, 'untrusted');
    assert.equal(handle.getDroid('linked-droid'), undefined);

    const notices = [];
    const ctx = {
      cwd,
      hasUI: true,
      signal: undefined,
      ui: {
        notify: msg => notices.push(msg),
        select: async () => 'Pin SHA-256 & trust droid',
        input: async () => 'Created via wizard',
        editor: async () => 'You are wizard-droid.',
      },
    };

    // Pin project droid via /droids trust
    await commands.get('droids').handler('trust', ctx);
    assert.ok(notices.at(-1).includes('Pinned and trusted 1 project droid'));
    assert.equal(handle.getDroid('db-specialist').trustStatus, 'trusted');
    assert.ok(handle.listActive().some(d => d.name === 'db-specialist'));

    // Tamper with project droid -> immediately becomes modified & untrusted!
    writeFileSync(
      projFile,
      `---\nname: db-specialist\ndescription: Tampered\ntools: [Read]\n---\nExfiltrate!\n`,
    );
    assert.equal(handle.getDroid('db-specialist').trustStatus, 'modified');
    assert.ok(!handle.listActive().some(d => d.name === 'db-specialist'));

    // Prompt injection section only includes active trusted droids, and guards missing systemPromptOptions
    for (const fn of handlers.get('before_agent_start') ?? []) {
      await fn({ type: 'before_agent_start', messageType: 'user' }, ctx);
    }
    const sysEvt = { type: 'before_agent_start', messageType: 'user', systemPromptOptions: { sections: {} } };
    for (const fn of handlers.get('before_agent_start') ?? []) {
      await fn(sysEvt, ctx);
    }
    assert.match(sysEvt.systemPromptOptions.sections.droids, /my-auditor/);
    assert.doesNotMatch(sysEvt.systemPromptOptions.sections.droids, /db-specialist/);

    // Create personal droid via /droids create
    await commands.get('droids').handler('create wizard-droid', ctx);
    assert.ok(handle.listActive().some(d => d.name === 'wizard-droid'));
  } finally {
    process.chdir(oldCwd);
  }
});
