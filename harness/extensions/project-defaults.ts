// Per-project launch defaults (permission mode, Spec, autonomy) stored outside the workspace in a
// private state directory, so the agent cannot raise its own defaults. Explicit --mode/--auto
// flags and a resumed session's saved state take precedence over these.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DefaultWriteMode = 'ask-edits' | 'accept-edits' | 'workflow';
export type DefaultAutonomy = 'off' | 'low' | 'medium';

export interface ProjectDefaults {
  mode?: DefaultWriteMode;
  /** Start in Spec (read-only planning); approving the spec returns to `mode`. */
  spec?: boolean;
  autonomy?: DefaultAutonomy;
  /** Extra never-auto script globs for this folder (on top of write-guard.json's). */
  neverAuto?: string[];
}

const WRITE_MODES = new Set<DefaultWriteMode>(['ask-edits', 'accept-edits', 'workflow']);
const AUTONOMY = new Set<DefaultAutonomy>(['off', 'low', 'medium']);
const MAX_BYTES = 4096;

export function defaultsBaseDir(): string {
  return process.env.PI_PROTECTED_STATE_DIR
    ? path.join(path.resolve(process.env.PI_PROTECTED_STATE_DIR), 'project-defaults')
    : path.join(os.homedir(), '.local/state/pi-protected/project-defaults');
}

export function sanitizeDefaults(raw: unknown): ProjectDefaults {
  const out: ProjectDefaults = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.mode === 'string' && WRITE_MODES.has(obj.mode as DefaultWriteMode)) out.mode = obj.mode as DefaultWriteMode;
  if (obj.spec === true) out.spec = true;
  if (typeof obj.autonomy === 'string' && AUTONOMY.has(obj.autonomy as DefaultAutonomy)) out.autonomy = obj.autonomy as DefaultAutonomy;
  if (Array.isArray(obj.neverAuto)) {
    const globs = [...new Set(obj.neverAuto.filter((g): g is string => typeof g === 'string' && isNeverAutoGlob(g)))].slice(0, 50);
    if (globs.length) out.neverAuto = globs;
  }
  return out;
}

export function isNeverAutoGlob(glob: string): boolean {
  return /^[A-Za-z0-9_.*?\[\]\/-]{1,100}$/.test(glob) && /[A-Za-z0-9]/.test(glob);
}

export function describeDefaults(d: ProjectDefaults): string {
  const parts: string[] = [];
  if (d.spec) parts.push(`Spec → ${d.mode ?? 'accept-edits'}`);
  else if (d.mode) parts.push(d.mode);
  if (d.autonomy) parts.push(`Auto (${d.autonomy[0].toUpperCase()}${d.autonomy.slice(1)})`);
  return parts.length ? parts.join(', ') : 'none (built-in: accept-edits, Auto Off)';
}

export function projectDefaultsStore(cwd: string, baseDir = defaultsBaseDir()) {
  const root = (() => { try { return realpathSync(cwd); } catch { return path.resolve(cwd); } })();
  const base = path.resolve(baseDir);
  const rel = path.relative(root, base);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('Project defaults must be stored outside the workspace.');
  }
  const file = path.join(base, `${createHash('sha256').update(root).digest('hex').slice(0, 32)}.json`);

  function read(): ProjectDefaults {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > MAX_BYTES) {
        return {};
      }
      const buf = Buffer.alloc(st.size);
      let total = 0;
      while (total < buf.length) {
        const n = readSync(fd, buf, total, buf.length - total, null);
        if (!n) break;
        total += n;
      }
      const parsed = JSON.parse(buf.subarray(0, total).toString('utf8')) as { root?: unknown };
      if (parsed.root !== root) return {};
      return sanitizeDefaults(parsed);
    } catch {
      return {};
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function write(next: ProjectDefaults): ProjectDefaults {
    const clean = sanitizeDefaults(next);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      throw new Error('Project defaults directory must be a private user-owned directory.');
    }
    if (!clean.mode && !clean.spec && !clean.autonomy && !clean.neverAuto) {
      rmSync(file, { force: true });
      return clean;
    }
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, root, ...clean }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
    return clean;
  }

  return {
    read,
    write,
    update(patch: Partial<Record<keyof ProjectDefaults, ProjectDefaults[keyof ProjectDefaults] | null>>): ProjectDefaults {
      const current = read() as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === false) delete current[key];
        else current[key] = value;
      }
      return write(current as ProjectDefaults);
    },
  };
}
