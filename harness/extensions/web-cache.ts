// Short-lived cache for web search results and fetched pages, shared by the main session and its
// delegates (same user, same cache directory). Private 0700 directory / 0600 files outside any
// workspace; entries expire (15 min for searches, 30 min for pages by default) and old files are
// pruned on write. Values are untrusted web content, exactly as returned by the sandboxed helpers.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 300;
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

export function webCacheDir(): string {
  return process.env.PI_PROTECTED_WEB_CACHE_DIR
    ? path.resolve(process.env.PI_PROTECTED_WEB_CACHE_DIR)
    : path.join(os.homedir(), '.cache/pi-protected/web');
}

export interface CacheHit<T> {
  value: T;
  ageMs: number;
}

export function createWebCache(dir = webCacheDir(), now = () => Date.now()) {
  const file = (kind: string, key: string) =>
    path.join(dir, `${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`);

  function ensureDir(): boolean {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
    } catch {
      return false;
    }
  }

  function prune(): void {
    try {
      const entries = readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => {
          try {
            return { name, mtime: statSync(path.join(dir, name)).mtimeMs };
          } catch {
            return { name, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime);
      entries.forEach((entry, index) => {
        if (index >= MAX_ENTRIES || now() - entry.mtime > PRUNE_AGE_MS) rmSync(path.join(dir, entry.name), { force: true });
      });
    } catch {
      // Pruning is best-effort.
    }
  }

  return {
    get<T>(kind: string, key: string, ttlMs: number): CacheHit<T> | undefined {
      let fd: number | undefined;
      try {
        fd = openSync(file(kind, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > MAX_ENTRY_BYTES) return undefined;
        const buf = Buffer.alloc(st.size);
        let total = 0;
        while (total < buf.length) {
          const n = readSync(fd, buf, total, buf.length - total, null);
          if (!n) break;
          total += n;
        }
        const entry = JSON.parse(buf.subarray(0, total).toString('utf8')) as { at?: unknown; key?: unknown; value?: unknown };
        if (typeof entry.at !== 'number' || entry.key !== key) return undefined;
        const ageMs = now() - entry.at;
        if (ageMs < 0 || ageMs > ttlMs) return undefined;
        return { value: entry.value as T, ageMs };
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
    set(kind: string, key: string, value: unknown): void {
      if (!ensureDir()) return;
      const data = JSON.stringify({ at: now(), key, value });
      if (Buffer.byteLength(data) > MAX_ENTRY_BYTES) return;
      const target = file(kind, key);
      const tmp = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, target);
      } catch {
        // A cache write failure only costs a refetch.
      } finally {
        rmSync(tmp, { force: true });
      }
      prune();
    },
  };
}

export type WebCache = ReturnType<typeof createWebCache>;

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'under a minute' : `${minutes} min`;
}
