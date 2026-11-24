// Run log for reproducibility: every workspace Python script run (foreground or background job)
// is recorded with its arguments, the code fingerprint from script-grants.ts (script plus local
// imports), the turn's checkpoint, exit status, duration, and the tail of its output. Stored per
// launch folder outside the workspace (private 0600 JSONL); output tails are redacted with the
// egress guard so dotenv values and credential-shaped strings are not kept.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunRecord {
  id: number;
  /** ISO start time. */
  at: string;
  command: string;
  /** Grant key form, e.g. `python3 scripts/backtest.py` or `python3 -m scripts.daily_memo`. */
  script: string;
  args: string[];
  /** SHA-256 over the script and its resolved local imports (null when it could not be pinned). */
  fingerprint: string | null;
  files: number;
  checkpoint?: string;
  status: 'ok' | 'failed' | 'timed out' | 'aborted' | 'cancelled';
  exitCode?: number;
  durationMs?: number;
  tail: string;
  /** Background job id, when started with pi_safe_job_start or /job. */
  job?: number;
  /** The fingerprint differs from the previous run of the same script. */
  codeChanged?: boolean;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_AFTER_ROTATE = 1000;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;

export function runLogBaseDir(): string {
  return process.env.PI_PROTECTED_STATE_DIR
    ? path.join(path.resolve(process.env.PI_PROTECTED_STATE_DIR), 'runs')
    : path.join(os.homedir(), '.local/state/pi-protected/runs');
}

/** Last lines of output with terminal control characters removed. */
export function outputTail(text: string, redact: (s: string) => string = s => s): string {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const lines = clean.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  const capped = lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
  return redact(capped);
}

/**
 * Outcome of a foreground pi_safe_bash call, or null when the command never ran (blocked or
 * denied before execution).
 */
export function bashOutcome(text: string, isError: boolean): { status: RunRecord['status']; exitCode?: number } | null {
  const exit = /Command exited with code (\d+)\s*$/.exec(text.trimEnd());
  if (exit) return { status: Number(exit[1]) === 0 ? 'ok' : 'failed', exitCode: Number(exit[1]) };
  if (/Command timed out after/i.test(text)) return { status: 'timed out' };
  if (/Command (?:was )?aborted/i.test(text)) return { status: 'aborted' };
  if (isError) return null;
  return { status: 'ok', exitCode: 0 };
}

/** The leading simple command of a pipeline or redirect (`python3 x.py > out.txt` → `python3 x.py`). */
export function leadingCommand(command: string): string {
  return command.split(/\s*(?:\|\|?|&&|;|\d?>>?|<)\s*/)[0].trim();
}

export function formatRunLine(r: RunRecord): string {
  const when = r.at.slice(5, 16).replace('T', ' ');
  const status = r.status === 'ok' || r.status === 'failed' ? `exit ${r.exitCode ?? '?'}` : r.status;
  const secs = r.durationMs !== undefined ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : '';
  const code = r.fingerprint ? ` · code ${r.fingerprint.slice(0, 8)}${r.files > 1 ? ` (${r.files} files)` : ''}${r.codeChanged ? ' changed' : ''}` : ' · code not pinned';
  const ckpt = r.checkpoint ? ` · ckpt ${r.checkpoint.slice(-8)}` : '';
  const job = r.job !== undefined ? ` · job ${r.job}` : '';
  const cmd = r.command.length > 90 ? `${r.command.slice(0, 89)}…` : r.command;
  return `#${r.id}  ${when}  ${cmd}  — ${status}${secs}${code}${ckpt}${job}`;
}

export function formatRunDetail(r: RunRecord): string {
  return [
    `Run #${r.id} · ${r.at}`,
    `Command: ${r.command}`,
    `Script: ${r.script}${r.args.length ? `  args: ${r.args.join(' ')}` : ''}`,
    `Status: ${r.status}${r.exitCode !== undefined ? ` (exit ${r.exitCode})` : ''}${r.durationMs !== undefined ? ` in ${(r.durationMs / 1000).toFixed(1)}s` : ''}${r.job !== undefined ? ` · background job ${r.job}` : ''}`,
    `Code fingerprint: ${r.fingerprint ?? 'not pinned'}${r.files ? ` over ${r.files} file${r.files === 1 ? '' : 's'}` : ''}${r.codeChanged ? ' (changed since the previous run of this script)' : ''}`,
    `Checkpoint: ${r.checkpoint ?? 'none'}${r.checkpoint ? ' (workspace state at the start of that turn; restore with /rewind)' : ''}`,
    'Output tail:',
    r.tail ? r.tail.split('\n').map(line => `  ${line}`).join('\n') : '  (no output)',
  ].join('\n');
}

export function runLogStore(cwd: string, baseDir = runLogBaseDir()) {
  const root = (() => { try { return realpathSync(cwd); } catch { return path.resolve(cwd); } })();
  const base = path.resolve(baseDir);
  const rel = path.relative(root, base);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('The run log must be stored outside the workspace.');
  }
  const file = path.join(base, `${createHash('sha256').update(root).digest('hex').slice(0, 32)}.jsonl`);
  let nextId: number | undefined;

  function ensureDir(): void {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const st = lstatSync(base);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
      throw new Error('Run log directory must be a private user-owned directory.');
    }
  }

  function readAll(): RunRecord[] {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > MAX_FILE_BYTES * 2) return [];
      const buf = Buffer.alloc(st.size);
      let total = 0;
      while (total < buf.length) {
        const n = readSync(fd, buf, total, buf.length - total, null);
        if (!n) break;
        total += n;
      }
      const out: RunRecord[] = [];
      for (const line of buf.subarray(0, total).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as RunRecord;
          if (typeof rec.id === 'number' && typeof rec.command === 'string' && typeof rec.script === 'string') out.push(rec);
        } catch {
          // Skip a damaged line; the rest of the log stays readable.
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function rotateIfLarge(): void {
    try {
      if (lstatSync(file).size <= MAX_FILE_BYTES) return;
    } catch {
      return;
    }
    const keep = readAll().slice(-KEEP_AFTER_ROTATE);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, keep.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  return {
    file,
    list: readAll,
    get(id: number): RunRecord | undefined {
      return readAll().find(r => r.id === id);
    },
    /** Most recent previous run of the same script, for "code changed" marking. */
    lastFor(script: string): RunRecord | undefined {
      return readAll().filter(r => r.script === script).at(-1);
    },
    append(record: Omit<RunRecord, 'id'>): RunRecord {
      ensureDir();
      if (nextId === undefined) nextId = (readAll().at(-1)?.id ?? 0) + 1;
      const full: RunRecord = { id: nextId++, ...record };
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('Run log file is not private.');
        writeSync(fd, `${JSON.stringify(full)}\n`);
      } finally {
        closeSync(fd);
      }
      rotateIfLarge();
      return full;
    },
    clear(): number {
      const count = readAll().length;
      rmSync(file, { force: true });
      nextId = 1;
      return count;
    },
    /** For tests: raw file text. */
    raw(): string {
      try { return readFileSync(file, 'utf8'); } catch { return ''; }
    },
  };
}
