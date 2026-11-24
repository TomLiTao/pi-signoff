import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerSkills } from './skills.ts';

test('user skills load automatically while project skills require hash-pinned /skills trust across all bundled files', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-skills-test-'));
  const old = process.cwd();
  const project = path.join(root, 'project');
  const launcherDir = path.join(root, 'launcher');
  const userSkillsDir = path.join(root, 'user-skills');
  mkdirSync(path.join(userSkillsDir, 'helper'), { recursive: true });
  mkdirSync(path.join(project, '.agents/skills/deploy/scripts'), { recursive: true });
  mkdirSync(launcherDir, { recursive: true });

  writeFileSync(path.join(userSkillsDir, 'helper/SKILL.md'), '---\ndescription: User helper skill\n---\n# Helper\n');
  writeFileSync(path.join(project, '.agents/skills/deploy/SKILL.md'), '---\ndescription: Deploy checklist\n---\n# Deploy\n');
  writeFileSync(path.join(project, '.agents/skills/deploy/scripts/check.sh'), '#!/bin/sh\necho ok\n');

  try {
    process.chdir(project);
    const commands = new Map();
    const hooks = new Map();
    const notices = [];

    const handle = registerSkills(
      {
        registerCommand: (n, c) => commands.set(n, c.handler),
        on: (e, h) => hooks.set(e, h),
      },
      {
        dir: launcherDir,
        enabled: true,
        secretPaths: ['.env'],
        userSkillsDir,
      },
    );

    const ctx = {
      cwd: project,
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify: msg => notices.push(msg),
        select: async (_t, opts) => opts[0],
        editor: async (_t, v) => v,
        confirm: async () => true,
      },
    };

    // Initially ONLY user skill is active; untrusted project skill is NOT mounted or discovered!
    assert.deepEqual(handle.activeSkillMounts().map(m => m[1]), ['helper']);
    const disc1 = hooks.get('resources_discover')({ type: 'resources_discover', cwd: project, reason: 'startup' }, ctx);
    assert.equal(disc1.skillPaths.length, 1);
    assert.match(disc1.skillPaths[0], /user-skills\/helper\/SKILL\.md$/);

    // Trust project skill
    await commands.get('skills')('trust', ctx);
    assert.deepEqual(handle.activeSkillMounts().map(m => m[1]), ['helper', 'deploy']);

    const startEvt = { systemPromptOptions: { sections: {} } };
    hooks.get('before_agent_start')(startEvt, ctx);
    assert.match(startEvt.systemPromptOptions.sections.skills, /\/opt\/pi-skills\/helper\/SKILL\.md/);
    assert.match(startEvt.systemPromptOptions.sections.skills, /\/opt\/pi-skills\/deploy\/SKILL\.md/);

    // Tamper with a bundled script inside .agents/skills/deploy/scripts/check.sh -> skill immediately invalidated!
    writeFileSync(path.join(project, '.agents/skills/deploy/scripts/check.sh'), '#!/bin/sh\necho tampered\n');
    notices.length = 0;
    const disc2 = hooks.get('resources_discover')({ type: 'resources_discover', cwd: project, reason: 'reload' }, ctx);
    assert.equal(disc2.skillPaths.length, 1);
    assert.deepEqual(handle.activeSkillMounts().map(m => m[1]), ['helper']);
    assert.ok(notices.some(m => m.includes('Project skill "deploy" changed since approval')));
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});

test('fallback codexSkillsDir loads verified user skills, skips dot-directories (.system), and yields to primary userSkillsDir', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-skills-codex-'));
  const old = process.cwd();
  const project = path.join(root, 'project');
  const launcherDir = path.join(root, 'launcher');
  const userSkillsDir = path.join(root, 'user-skills');
  const codexSkillsDir = path.join(root, 'codex-skills');
  mkdirSync(project, { recursive: true });
  mkdirSync(launcherDir, { recursive: true });
  mkdirSync(path.join(userSkillsDir, 'shared'), { recursive: true });
  mkdirSync(path.join(codexSkillsDir, 'shared'), { recursive: true });
  mkdirSync(path.join(codexSkillsDir, 'research-efficiency'), { recursive: true });
  mkdirSync(path.join(codexSkillsDir, '.system'), { recursive: true });

  writeFileSync(path.join(userSkillsDir, 'shared/SKILL.md'), '---\ndescription: Primary shared\n---\n# Primary\n');
  writeFileSync(path.join(codexSkillsDir, 'shared/SKILL.md'), '---\ndescription: Codex shared\n---\n# Codex\n');
  writeFileSync(path.join(codexSkillsDir, 'research-efficiency/SKILL.md'), '---\ndescription: Research workflow\n---\n# Research\n');
  writeFileSync(path.join(codexSkillsDir, '.system/SKILL.md'), '---\ndescription: Hidden system\n---\n# System\n');

  try {
    process.chdir(project);
    const hooks = new Map();
    const handle = registerSkills(
      { registerCommand() {}, on: (e, h) => hooks.set(e, h) },
      { dir: launcherDir, enabled: true, secretPaths: ['.env'], userSkillsDir, codexSkillsDir },
    );
    const mounts = handle.activeSkillMounts();
    assert.deepEqual(mounts.map(m => m[1]), ['shared', 'research-efficiency']);
    assert.match(mounts[0][0], /user-skills\/shared$/, 'primary userSkillsDir takes precedence');
    assert.match(mounts[1][0], /codex-skills\/research-efficiency$/);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});
