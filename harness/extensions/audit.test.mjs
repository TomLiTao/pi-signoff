import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuditLogger, digestArgs } from './audit.ts';

test('audit logger writes private JSONL records with canonical args digests and no raw secrets', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-audit-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  const auditDir = path.join(base, 'audit');
  mkdirSync(work);

  const logger = createAuditLogger(work, auditDir);
  logger.setSession('sess-01');
  logger.record({
    tool: 'pi_safe_bash',
    args: { command: 'pytest -q', secretNote: 'SUPER_SECRET_VALUE' },
    decision: 'approved',
    rule: 'user-approved-once',
    prompted: true,
  });
  logger.record({
    tool: 'pi_safe_read',
    args: { path: 'README.md' },
    decision: 'allow',
    rule: 'read-only-tool',
  });

  const file = logger.getSessionFile();
  assert.equal(statSync(auditDir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /SUPER_SECRET_VALUE/);
  const lines = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'pi_safe_bash');
  assert.equal(lines[0].decision, 'approved');
  assert.equal(lines[0].rule, 'user-approved-once');
  assert.equal(lines[0].prompted, true);
  assert.equal(lines[0].argsDigest, digestArgs({ secretNote: 'SUPER_SECRET_VALUE', command: 'pytest -q' }));
  assert.equal(lines[1].prompted, false);
});

test('audit logger refuses symlinks, permissive directories, and in-workspace paths', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'pi-audit-safe-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  const inside = path.join(work, 'audit');
  const outside = path.join(base, 'audit');
  mkdirSync(work);

  const inWorkLogger = createAuditLogger(work, inside);
  inWorkLogger.setSession('s1');
  inWorkLogger.record({ tool: 'pi_safe_read', args: {}, decision: 'allow', rule: 'read-only' });
  assert.throws(() => inWorkLogger.getSessionFile(), /outside the workspace/);

  const logger = createAuditLogger(work, outside);
  logger.setSession('s2');
  logger.record({ tool: 'pi_safe_read', args: {}, decision: 'allow', rule: 'read-only' });
  const file = logger.getSessionFile();
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);

  // Symlinked target file must be rejected
  const target = path.join(base, 'target.jsonl');
  writeFileSync(target, '', { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  logger.record({ tool: 'pi_safe_read', args: {}, decision: 'allow', rule: 'read-only' });
  assert.equal(readFileSync(target, 'utf8'), '');

  // Permissive audit dir must be rejected
  rmSync(file);
  chmodSync(outside, 0o755);
  logger.record({ tool: 'pi_safe_read', args: {}, decision: 'allow', rule: 'read-only' });
  assert.throws(() => logger.getSessionFile(), /private/);
});
