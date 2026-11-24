import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type AuditDecision = 'allow' | 'approved' | 'denied' | 'block';

export interface AuditEvent {
  tool: string;
  args?: unknown;
  decision: AuditDecision;
  rule: string;
  prompted?: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function digestArgs(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex');
}

function sanitizeSessionId(raw?: string): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 96);
  return cleaned || `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function ensurePrivateDir(target: string): void {
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const st = lstatSync(target);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error(`Audit directory must be a private user-owned directory: ${target}`);
  }
}

export function createAuditLogger(cwd: string, customAuditDir?: string) {
  const launch = realpathSync(cwd);
  const configured = customAuditDir ?? process.env.PI_PROTECTED_AUDIT_DIR;
  let sessionId = sanitizeSessionId();

  function resolveAuditDir(): string {
    if (configured) {
      const parent = path.dirname(path.resolve(configured));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      ensurePrivateDir(path.resolve(configured));
      const real = realpathSync(configured);
      const rel = path.relative(launch, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        throw new Error('Audit directory must be outside the workspace.');
      }
      return real;
    }
    const cacheRoot = path.join(homedir(), '.cache');
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    const piCache = path.join(cacheRoot, 'pi-protected');
    ensurePrivateDir(piCache);
    const auditDir = path.join(piCache, 'audit');
    ensurePrivateDir(auditDir);
    const real = realpathSync(auditDir);
    const rel = path.relative(launch, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error('Audit directory must be outside the workspace.');
    }
    return real;
  }

  return {
    setSession(id?: string) {
      sessionId = sanitizeSessionId(id);
    },
    getSessionFile(): string {
      return path.join(resolveAuditDir(), `${sessionId}.jsonl`);
    },
    record(event: AuditEvent): void {
      try {
        const dir = resolveAuditDir();
        const file = path.join(dir, `${sessionId}.jsonl`);
        const fd = openSync(
          file,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
            throw new Error('Invalid audit log file.');
          }
          const line = JSON.stringify({
            ts: new Date().toISOString(),
            tool: event.tool,
            argsDigest: digestArgs(event.args),
            decision: event.decision,
            rule: event.rule,
            prompted: Boolean(event.prompted),
          }) + '\n';
          writeSync(fd, Buffer.from(line, 'utf8'));
        } finally {
          closeSync(fd);
        }
      } catch {
        // Audit logging is best-effort and never weakens fail-closed tool gating.
      }
    },
  };
}
